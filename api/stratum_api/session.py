"""Session-cookie middleware (httpOnly, Secure, SameSite=Lax, signed)."""

from __future__ import annotations

import hashlib
import hmac
import secrets
from collections.abc import Awaitable, Callable

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

COOKIE_NAME = "stratum_session"


def sign_session_id(session_id: str, secret: str) -> str:
    """Create a signed cookie token '<session_id>.<hex_hmac>'."""
    mac = hmac.new(
        secret.encode("utf-8"),
        session_id.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"{session_id}.{mac}"


def verify_session_token(token: str, secret: str) -> str | None:
    """Verify a signed cookie token and return session_id if valid."""
    if "." not in token:
        return None
    session_id, provided_mac = token.rsplit(".", 1)
    if not session_id or not provided_mac:
        return None
    expected_token = sign_session_id(session_id, secret)
    expected_mac = expected_token.rsplit(".", 1)[1]
    if hmac.compare_digest(provided_mac, expected_mac):
        return session_id
    return None


class SessionCookieMiddleware(BaseHTTPMiddleware):
    """Binds every request to a signed session cookie."""

    def __init__(self, app: ASGIApp, secret: str) -> None:
        super().__init__(app)
        self._secret = secret

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        raw_cookie = request.cookies.get(COOKIE_NAME)
        session_id = (
            verify_session_token(raw_cookie, self._secret)
            if raw_cookie
            else None
        )
        is_new = False
        if session_id is None:
            session_id = f"sess_{secrets.token_hex(16)}"
            is_new = True
        request.state.session_id = session_id
        response = await call_next(request)
        if is_new:
            signed = sign_session_id(session_id, self._secret)
            response.set_cookie(
                key=COOKIE_NAME,
                value=signed,
                httponly=True,
                secure=True,
                samesite="lax",
                path="/",
                max_age=60 * 60 * 24 * 7,
            )
        return response
