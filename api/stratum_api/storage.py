"""State and binary artifact repository for Firestore, GCS, and in-memory fakes."""

from __future__ import annotations

import datetime as dt
import json
from typing import Any

from stratum_api.config import AppConfig
from stratum_api.logging_utils import get_logger

logger = get_logger("stratum_api.storage")

# ponytail: unified repository interface keeping Firestore, GCS, and in-memory fakes interchangeable


class InMemoryStateRepository:
    """Thread-safe in-memory state and artifact store for unit tests and local dev."""

    def __init__(self) -> None:
        self._docs: dict[str, dict[str, dict[str, Any]]] = {}
        self._events: dict[str, list[dict[str, Any]]] = {}
        self._blobs: dict[str, dict[str, bytes]] = {}
        self._tokens: dict[str, dict[str, Any]] = {}

    def save_doc(self, run_id: str, key: str, data: dict[str, Any]) -> None:
        """Persist a JSON document for a run."""
        self._docs.setdefault(run_id, {})[key] = json.loads(json.dumps(data))

    def get_doc(self, run_id: str, key: str) -> dict[str, Any] | None:
        """Retrieve a JSON document for a run, or None if missing."""
        doc = self._docs.get(run_id, {}).get(key)
        return json.loads(json.dumps(doc)) if doc is not None else None

    def list_runs(self, limit: int = 50) -> list[dict[str, Any]]:
        """Return up to limit run records sorted newest first."""
        runs = [
            d["run"]
            for d in self._docs.values()
            if "run" in d and isinstance(d["run"], dict)
        ]
        runs.sort(key=lambda r: str(r.get("created_at", "")), reverse=True)
        return runs[:limit]

    def append_event(self, run_id: str, event: dict[str, Any]) -> None:
        """Append a RunEvent dictionary to the run's ordered event log."""
        self._events.setdefault(run_id, []).append(json.loads(json.dumps(event)))

    def list_events(self, run_id: str) -> list[dict[str, Any]]:
        """Return all RunEvents recorded for run_id in chronological order."""
        return list(self._events.get(run_id, []))

    def save_blob(
        self, run_id: str, rel_path: str, data: bytes, content_type: str = "application/octet-stream"
    ) -> str:
        """Store binary artifact bytes and return canonical artifact path."""
        _ = content_type
        self._blobs.setdefault(run_id, {})[rel_path] = bytes(data)
        return f"runs/{run_id}/{rel_path}"

    def get_blob(self, run_id: str, rel_path: str) -> bytes | None:
        """Retrieve binary artifact bytes for a run."""
        return self._blobs.get(run_id, {}).get(rel_path)

    def save_bridge_token(self, token_hash: str, record: dict[str, Any]) -> None:
        """Store bridge token hash lookup record (never raw token)."""
        self._tokens[token_hash] = json.loads(json.dumps(record))

    def get_bridge_token(self, token_hash: str) -> dict[str, Any] | None:
        """Look up bridge token record by SHA-256 hash."""
        rec = self._tokens.get(token_hash)
        return json.loads(json.dumps(rec)) if rec is not None else None

    def recover_interrupted_runs(self) -> int:
        """Mark any *_RUNNING runs as PARTIAL on startup and emit a warn RunEvent."""
        recovered = 0
        now_iso = dt.datetime.now(dt.timezone.utc).isoformat()
        for run_id in list(self._docs.keys()):
            run_doc = self.get_doc(run_id, "run")
            if not run_doc:
                continue
            status = str(run_doc.get("status", ""))
            if status.endswith("_RUNNING"):
                run_doc["status"] = "PARTIAL"
                run_doc["updated_at"] = now_iso
                self.save_doc(run_id, "run", run_doc)
                self.append_event(
                    run_id,
                    {
                        "run_id": run_id,
                        "ts": now_iso,
                        "stage": "recovery",
                        "level": "warn",
                        "message": f"Interrupted status {status} marked PARTIAL on startup.",
                    },
                )
                recovered += 1
        return recovered


class CloudStateRepository(InMemoryStateRepository):
    """Cloud Run state repository backed by Firestore/GCS with local write-through cache."""

    def __init__(self, config: AppConfig) -> None:
        super().__init__()
        self._config = config
        self._fs_client: Any | None = None
        self._gcs_client: Any | None = None

    def _bucket(self) -> Any | None:
        if not self._config.k_service and self._config.gcp_project == "stratum-dev":
            return None
        try:
            if self._gcs_client is None:
                from google.cloud import storage  # type: ignore[import-untyped]

                self._gcs_client = storage.Client(project=self._config.gcp_project)
            return self._gcs_client.bucket(self._config.artifact_bucket)
        except Exception as exc:  # noqa: BLE001
            logger.log_event("gcs_unavailable", stage="storage", level="WARNING", message=str(exc))
            return None

    def _firestore(self) -> Any | None:
        if self._config.state_backend != "firestore":
            return None
        if not self._config.k_service and self._config.gcp_project == "stratum-dev":
            return None
        try:
            if self._fs_client is None:
                from google.cloud import firestore  # type: ignore[import-untyped]

                self._fs_client = firestore.Client(project=self._config.gcp_project)
            return self._fs_client
        except Exception as exc:  # noqa: BLE001
            logger.log_event("firestore_unavailable", stage="storage", level="WARNING", message=str(exc))
            return None

    def save_doc(self, run_id: str, key: str, data: dict[str, Any]) -> None:
        super().save_doc(run_id, key, data)
        fs = self._firestore()
        if fs is not None:
            try:
                fs.collection("stratum_runs").document(run_id).collection("docs").document(key).set(data)
                return
            except Exception as exc:  # noqa: BLE001
                logger.log_event("firestore_write_err", run_id=run_id, stage="storage", level="WARNING", message=str(exc))
        bucket = self._bucket()
        if bucket is not None:
            try:
                blob = bucket.blob(f"runs/{run_id}/state/{key}.json")
                blob.upload_from_string(json.dumps(data), content_type="application/json")
            except Exception as exc:  # noqa: BLE001
                logger.log_event("gcs_doc_write_err", run_id=run_id, stage="storage", level="WARNING", message=str(exc))

    def get_doc(self, run_id: str, key: str) -> dict[str, Any] | None:
        cached = super().get_doc(run_id, key)
        if cached is not None:
            return cached
        fs = self._firestore()
        if fs is not None:
            try:
                snap = fs.collection("stratum_runs").document(run_id).collection("docs").document(key).get()
                if snap.exists:
                    data = snap.to_dict() or {}
                    super().save_doc(run_id, key, data)
                    return data
            except Exception:  # noqa: BLE001
                pass
        bucket = self._bucket()
        if bucket is not None:
            try:
                blob = bucket.blob(f"runs/{run_id}/state/{key}.json")
                if blob.exists():
                    data = json.loads(blob.download_as_text())
                    super().save_doc(run_id, key, data)
                    return data
            except Exception:  # noqa: BLE001
                pass
        return None

    def save_blob(
        self, run_id: str, rel_path: str, data: bytes, content_type: str = "application/octet-stream"
    ) -> str:
        uri = super().save_blob(run_id, rel_path, data, content_type)
        bucket = self._bucket()
        if bucket is not None:
            try:
                bucket.blob(uri).upload_from_string(data, content_type=content_type)
            except Exception as exc:  # noqa: BLE001
                logger.log_event("gcs_blob_write_err", run_id=run_id, stage="storage", level="WARNING", message=str(exc))
        return uri

    def get_blob(self, run_id: str, rel_path: str) -> bytes | None:
        cached = super().get_blob(run_id, rel_path)
        if cached is not None:
            return cached
        bucket = self._bucket()
        if bucket is not None:
            try:
                blob = bucket.blob(f"runs/{run_id}/{rel_path}")
                if blob.exists():
                    raw = blob.download_as_bytes()
                    super().save_blob(run_id, rel_path, raw)
                    return raw
            except Exception:  # noqa: BLE001
                pass
        return None


def create_repository(config: AppConfig) -> InMemoryStateRepository:
    """Create the appropriate state repository for config."""
    if not config.k_service and config.gcp_project == "stratum-dev":
        return InMemoryStateRepository()
    return CloudStateRepository(config)
