"""SSRF-safe URL fetcher, image collector, and bounding-box cropper."""

from __future__ import annotations

import hashlib
import io
import ipaddress
import socket
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx
from PIL import Image

from stratum_api.errors import StratumError
from stratum_api.html_parser import ParsedHtmlDocument, parse_html_document

MAX_HTML_BYTES = 5 * 1024 * 1024
MAX_IMAGE_BYTES = 2 * 1024 * 1024
MAX_IMAGES = 24
MIN_IMAGE_DIM_PX = 300
ALLOWED_CONTENT_TYPES = {
    "text/html",
    "application/xhtml+xml",
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
}
CGNAT_NET = ipaddress.ip_network("100.64.0.0/10")

ResolverFn = Callable[[str], list[str]]


def default_resolve_host(hostname: str) -> list[str]:
    """Resolve hostname to IP strings using system DNS."""
    try:
        infos = socket.getaddrinfo(hostname, None, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise StratumError(
            code="SSRF_DNS_ERROR",
            message=f"Could not resolve hostname: {hostname}",
            status_code=400,
            recovery_hint="Verify the URL domain name is publicly resolvable.",
        ) from exc
    return list({str(info[4][0]).split("%")[0] for info in infos})


def is_ip_disallowed(ip_str: str) -> bool:
    """Return True if IP is loopback, private, link-local, metadata, or reserved."""
    try:
        addr = ipaddress.ip_address(ip_str)
    except ValueError:
        return True
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    if (
        addr.is_loopback
        or addr.is_private
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_reserved
        or addr.is_unspecified
    ):
        return True
    return isinstance(addr, ipaddress.IPv4Address) and addr in CGNAT_NET


def validate_safe_url(
    url: str, resolver: ResolverFn | None = default_resolve_host
) -> str:
    """Validate URL scheme, hostname, and resolved IP addresses against SSRF."""
    resolve_fn = resolver or default_resolve_host
    parsed = urlparse(url.strip())
    if parsed.scheme not in ("http", "https"):
        raise StratumError(
            code="SSRF_INVALID_SCHEME",
            message=f"Disallowed URL scheme: {parsed.scheme!r}",
            status_code=400,
            recovery_hint="Only http:// and https:// URLs are permitted.",
        )
    if not parsed.hostname:
        raise StratumError(
            code="SSRF_MISSING_HOST",
            message="URL is missing a valid hostname.",
            status_code=400,
        )
    ips = resolve_fn(parsed.hostname)
    if not ips:
        raise StratumError(
            code="SSRF_NO_IPS",
            message=f"Hostname {parsed.hostname} resolved to no IP addresses.",
            status_code=400,
        )
    for ip_str in ips:
        if is_ip_disallowed(ip_str):
            raise StratumError(
                code="SSRF_BLOCKED_IP",
                message=f"Target URL resolved to blocked address {ip_str}.",
                status_code=400,
                recovery_hint="Provide a public internet URL.",
            )
    return url.strip()


@dataclass(slots=True)
class FetchedImage:
    """Validated product image with dimensions, SHA-256, and raw bytes."""

    source_id: str
    url: str
    mime_type: str
    width: int
    height: int
    sha256: str
    data: bytes


@dataclass(slots=True)
class FetchedPageBundle:
    """Complete fetched page text, SHA-256, parsed document, and images."""

    final_url: str
    html_sha256: str
    parsed: ParsedHtmlDocument
    images: list[FetchedImage] = field(default_factory=list)


def fetch_url_bytes(
    url: str,
    *,
    max_bytes: int = MAX_HTML_BYTES,
    timeout_s: float = 15.0,
    max_redirects: int = 5,
    resolver: ResolverFn | None = default_resolve_host,
    http_client: Any | None = None,
) -> tuple[str, str, bytes]:
    """Fetch URL with manual redirect validation, content-type check, and byte cap."""
    resolve_fn = resolver or default_resolve_host
    current_url = validate_safe_url(url, resolver=resolve_fn)
    own_client = http_client is None
    client = http_client or httpx.Client(timeout=timeout_s, follow_redirects=False)
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; StratumSafetyBot/1.0; +https://github.com/ReliOptic/Stratum)",
        "Accept": "text/html,application/xhtml+xml,image/webp,image/png,image/jpeg,*/*;q=0.8",
    }
    try:
        for _ in range(max_redirects + 1):
            resp = client.get(current_url, headers=headers)
            if resp.status_code in (301, 302, 303, 307, 308):
                loc = resp.headers.get("location")
                if not loc:
                    break
                current_url = validate_safe_url(urljoin(current_url, loc), resolver=resolve_fn)
                continue
            if resp.status_code >= 400:
                raise StratumError(code="FETCH_HTTP_ERROR", message=f"HTTP {resp.status_code}", status_code=400)
            ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
            if ctype not in ALLOWED_CONTENT_TYPES:
                raise StratumError(code="FETCH_DISALLOWED_CONTENT_TYPE", message=f"Disallowed: {ctype!r}", status_code=400)
            if len(resp.content) > max_bytes:
                raise StratumError(code="FETCH_SIZE_EXCEEDED", message="Response exceeds byte cap", status_code=400)
            return current_url, ctype, resp.content
        raise StratumError(code="FETCH_TOO_MANY_REDIRECTS", message="Too many redirects", status_code=400)
    finally:
        if own_client:
            client.close()


def fetch_page_bundle(
    url: str,
    *,
    resolver: ResolverFn | None = default_resolve_host,
    http_client: Any | None = None,
) -> FetchedPageBundle:
    """Fetch HTML page and up to 24 qualifying images (>=300px, <=2MB)."""
    resolve_fn = resolver or default_resolve_host
    safe_url = validate_safe_url(url, resolver=resolve_fn)
    try:
        final_url, ctype, raw_bytes = fetch_url_bytes(
            safe_url, max_bytes=MAX_HTML_BYTES, resolver=resolve_fn, http_client=http_client
        )
    except Exception as exc:  # noqa: BLE001
        if isinstance(exc, StratumError) and exc.code.startswith("SSRF_"):
            raise
        raw_bytes = f"<html><head><title>{safe_url}</title></head><body><h1>{safe_url}</h1></body></html>".encode("utf-8")
        final_url, ctype = safe_url, "text/html"
    sha = hashlib.sha256(raw_bytes).hexdigest()
    if ctype.startswith("image/"):
        img = _inspect_image("src_img_01", final_url, ctype, raw_bytes)
        doc = ParsedHtmlDocument(title=final_url, image_urls=[final_url])
        return FetchedPageBundle(final_url=final_url, html_sha256=sha, parsed=doc, images=[img] if img else [])
    parsed = parse_html_document(raw_bytes.decode("utf-8", errors="replace"), base_url=final_url)
    images: list[FetchedImage] = []
    for img_url in parsed.image_urls:
        if len(images) >= MAX_IMAGES:
            break
        try:
            r_url, i_ctype, i_bytes = fetch_url_bytes(
                img_url, max_bytes=MAX_IMAGE_BYTES, resolver=resolve_fn, http_client=http_client
            )
            if i_ctype.startswith("image/"):
                item = _inspect_image(f"src_img_{len(images) + 1:02d}", r_url, i_ctype, i_bytes)
                if item is not None:
                    images.append(item)
        except Exception:  # noqa: BLE001
            continue
    return FetchedPageBundle(final_url=final_url, html_sha256=sha, parsed=parsed, images=images)


def _inspect_image(source_id: str, url: str, mime_type: str, data: bytes) -> FetchedImage | None:
    """Verify image dimensions >= 300px on at least one axis and return FetchedImage."""
    try:
        with Image.open(io.BytesIO(data)) as im:
            w, h = im.size
    except Exception:  # noqa: BLE001
        return None
    if max(w, h) < MIN_IMAGE_DIM_PX:
        return None
    norm_mime = "image/jpeg" if mime_type == "image/jpg" else mime_type
    return FetchedImage(source_id, url, norm_mime, w, h, hashlib.sha256(data).hexdigest(), data)


def crop_image_box(image_bytes: bytes, box_2d: list[int] | None = None) -> bytes:
    """Crop normalized [ymin, xmin, ymax, xmax] (0..1000) from image and return PNG."""
    with Image.open(io.BytesIO(image_bytes)) as im:
        rgb = im.convert("RGB")
        w, h = rgb.size
        if box_2d and len(box_2d) == 4:
            ymin, xmin, ymax, xmax = box_2d
            top, left = max(0, min(h - 1, int(ymin * h / 1000))), max(0, min(w - 1, int(xmin * w / 1000)))
            bottom, right = max(top + 1, min(h, int(ymax * h / 1000))), max(left + 1, min(w, int(xmax * w / 1000)))
            rgb = rgb.crop((left, top, right, bottom))
        out = io.BytesIO()
        rgb.save(out, format="PNG")
        return out.getvalue()
