"""Shared HTTP client helpers for talking to an InvokeAI backend.

This module owns everything needed to make authenticated calls against a
running InvokeAI instance: URL validation, the JWT token cache with its
single-user/multi-user fallback logic, and thin wrappers around the
InvokeAI REST endpoints PhotoMap consumes (version probe, board listing,
board image names, image deletion).

It deliberately lives outside ``routers/`` so that non-router code (the
indexing pipeline, curation) can use it without importing a FastAPI router
module. ``routers/invoke.py`` re-exports the auth helpers for backward
compatibility with existing tests.

The token cache holds a single entry keyed by ``(base_url, username)``.
Per-album credentials that differ from the global settings will therefore
thrash it — each switch costs one extra login round-trip. That is
acceptable for the access patterns here (indexing and deletion are not
high-frequency), so no multi-entry cache is kept.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Awaitable, Callable
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException

logger = logging.getLogger(__name__)

# 5 seconds is plenty for a local loopback call; anything slower almost
# certainly means the backend is unreachable rather than genuinely busy.
_HTTP_TIMEOUT = 5.0

# Listing the image names of a very large board can legitimately take
# longer than the snappy 5s used for control-plane calls.
_BOARD_FETCH_TIMEOUT = 30.0

# ── InvokeAI JWT token cache ──────────────────────────────────────────
_cached_token: str | None = None
_token_expires_at: float = 0.0
_token_base_url: str | None = None
_token_username: str | None = None


def _cached_auth_headers(base_url: str, username: str | None) -> dict[str, str]:
    """Return ``{"Authorization": "Bearer ..."}`` if we still hold a valid
    cached token for this ``(base_url, username)`` pair, else ``{}``.

    This never talks to the network.  Deliberate: the first attempt at any
    request always uses whatever auth we already have (or none), so that a
    backend that has since been reconfigured into single-user mode is given
    a chance to accept the call anonymously.
    """
    if (
        _cached_token
        and time.monotonic() < _token_expires_at
        and _token_base_url == base_url
        and _token_username == username
    ):
        return {"Authorization": f"Bearer {_cached_token}"}
    return {}


async def _login(base_url: str, username: str, password: str) -> dict[str, str]:
    """Exchange ``username``/``password`` for a JWT via the InvokeAI auth
    endpoint, cache the token, and return the ``Authorization`` header.
    """
    global _cached_token, _token_expires_at, _token_base_url, _token_username  # noqa: PLW0603

    login_url = f"{base_url.rstrip('/')}/api/v1/auth/login"
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            resp = await client.post(login_url, json={"email": username, "password": password})
    except httpx.RequestError as exc:
        logger.warning("InvokeAI auth request failed: %s", exc)
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach InvokeAI backend for authentication: {exc}",
        ) from exc

    if resp.status_code != 200:
        detail = resp.json().get("detail", resp.text[:200]) if resp.headers.get("content-type", "").startswith("application/json") else resp.text[:200]
        raise HTTPException(
            status_code=502,
            detail=f"InvokeAI authentication failed ({resp.status_code}): {detail}",
        )

    data = resp.json()
    _cached_token = data["token"]
    _token_expires_at = time.monotonic() + data.get("expires_in", 86400) - 60  # refresh 60s early
    _token_base_url = base_url
    _token_username = username
    return {"Authorization": f"Bearer {_cached_token}"}


def _invalidate_token_cache() -> None:
    """Clear the cached token so the next request re-authenticates."""
    global _cached_token, _token_expires_at, _token_base_url, _token_username  # noqa: PLW0603
    _cached_token = None
    _token_expires_at = 0.0
    _token_base_url = None
    _token_username = None


async def _request_with_auth_fallback(
    base_url: str,
    username: str | None,
    password: str | None,
    request_fn: Callable[[dict[str, str]], Awaitable[httpx.Response]],
) -> httpx.Response:
    """Perform an InvokeAI request with graceful handling of auth transitions.

    ``request_fn`` is an async callable that takes a headers dict and
    performs the HTTP call — using a factory lets the caller re-open file
    streams (needed for multipart uploads) on a retry.

    Three-step flow:

    1. First attempt uses whatever token we have cached (or no auth at all).
       A freshly-restarted single-user backend then accepts the call even
       if credentials are stored in PhotoMap.
    2. If the first attempt returns **401**, the backend demands
       authentication: if credentials are configured we log in, cache a
       fresh token, and retry.
    3. If the first attempt was made *with* a token and returns **403**
       (most commonly "Multiuser mode is disabled. Authentication is not
       required…"), the backend was reconfigured to single-user mode — we
       invalidate the cached token and retry anonymously.
    """
    auth_headers = _cached_auth_headers(base_url, username)
    response = await request_fn(auth_headers)

    if response.status_code == 401 and username and password:
        _invalidate_token_cache()
        auth_headers = await _login(base_url, username, password)
        response = await request_fn(auth_headers)
    elif response.status_code == 403 and auth_headers:
        _invalidate_token_cache()
        response = await request_fn({})

    return response


def _validate_invokeai_url(url: str | None) -> str | None:
    """Reject non-http(s) schemes so configured URLs cannot be used for SSRF.

    The configured URL is later concatenated into outbound requests; ``httpx``
    already refuses non-http(s) schemes, but validating up front returns
    a clean 400 to the caller rather than a 502 at call time, and blocks
    obviously-wrong values like ``file://`` or ``javascript:`` from ever
    reaching the config file.

    Empty / None is allowed — that's "not configured yet".
    """
    if not url:
        return url
    try:
        parts = urlsplit(url)
    except ValueError as exc:
        raise HTTPException(
            status_code=400, detail=f"Invalid InvokeAI URL: {exc}"
        ) from exc
    if parts.scheme not in {"http", "https"}:
        raise HTTPException(
            status_code=400,
            detail="InvokeAI URL must use http:// or https://",
        )
    if not parts.netloc:
        raise HTTPException(
            status_code=400, detail="InvokeAI URL must include a host"
        )
    return url


async def check_status(base_url: str | None) -> dict:
    """Report whether ``base_url`` is reachable and looks like InvokeAI.

    Probes the unauthenticated ``/api/v1/app/version`` endpoint.  Returns
    ``{"reachable": True, "version": ...}`` on success and
    ``{"reachable": False, "detail": ...}`` for any network or HTTP failure
    rather than raising, so callers can render a neutral hint instead of an
    error banner while the user is still typing.
    """
    if not base_url:
        return {"reachable": False, "detail": "No InvokeAI URL configured"}

    version_url = f"{base_url.rstrip('/')}/api/v1/app/version"
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            resp = await client.get(version_url)
    except httpx.RequestError as exc:
        return {"reachable": False, "detail": f"Could not reach backend: {exc}"}

    if resp.status_code != 200:
        return {
            "reachable": False,
            "detail": f"Backend returned HTTP {resp.status_code}",
        }
    not_invokeai = "Server is reachable but doesn't appear to be an InvokeAI backend"
    try:
        payload = resp.json()
    except ValueError:
        return {"reachable": False, "detail": not_invokeai}
    version = payload.get("version")
    if not version:
        # A non-InvokeAI server happening to have /api/v1/app/version would
        # almost certainly not return a version field.
        return {"reachable": False, "detail": not_invokeai}
    return {"reachable": True, "version": version}


async def list_boards(
    base_url: str,
    username: str | None,
    password: str | None,
) -> list[dict]:
    """Return the boards available on ``base_url``.

    Uses the same auth-fallback pattern as the other wrappers.  Returns a
    flat ``[{"board_id": ..., "board_name": ...}]`` list.  Any failure
    (unreachable, auth, 5xx) raises 502.
    """
    boards_url = f"{base_url.rstrip('/')}/api/v1/boards/"

    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:

            async def _do(headers: dict[str, str]) -> httpx.Response:
                return await client.get(
                    boards_url, params={"all": "true"}, headers=headers
                )

            response = await _request_with_auth_fallback(
                base_url, username, password, _do
            )
    except httpx.RequestError as exc:
        logger.warning("InvokeAI boards request failed: %s", exc)
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach InvokeAI backend at {base_url}: {exc}",
        ) from exc

    if response.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=(
                f"InvokeAI backend returned {response.status_code}: "
                f"{response.text[:200]}"
            ),
        )

    try:
        raw = response.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=502, detail="Boards endpoint did not return JSON"
        ) from exc

    # ``?all=true`` returns a flat list; without it InvokeAI returns
    # ``{"items": [...], "offset": ..., "total": ...}``.  Handle both shapes
    # so an accidentally-paginated response doesn't blank out the dropdown.
    items = raw if isinstance(raw, list) else raw.get("items", [])
    return [
        {
            "board_id": item.get("board_id"),
            "board_name": item.get("board_name") or "(unnamed board)",
        }
        for item in items
        if isinstance(item, dict) and item.get("board_id")
    ]


async def fetch_board_image_names(
    base_url: str,
    board_ids: list[str],
    username: str | None,
    password: str | None,
) -> list[str]:
    """Return the image names belonging to ``board_ids``, deduplicated.

    Calls ``GET /api/v1/boards/{board_id}/image_names`` for each board.
    The special board id ``"none"`` is InvokeAI's Uncategorized bucket.
    Returned names include their file extension (``{uuid}.png`` style).
    Raises 502 on any network error or non-200 response.
    """
    all_names: list[str] = []
    try:
        async with httpx.AsyncClient(timeout=_BOARD_FETCH_TIMEOUT) as client:
            for board_id in board_ids:
                names_url = (
                    f"{base_url.rstrip('/')}/api/v1/boards/{board_id}/image_names"
                )

                async def _do(
                    headers: dict[str, str], url: str = names_url
                ) -> httpx.Response:
                    return await client.get(url, headers=headers)

                response = await _request_with_auth_fallback(
                    base_url, username, password, _do
                )
                if response.status_code >= 400:
                    raise HTTPException(
                        status_code=502,
                        detail=(
                            f"InvokeAI backend returned {response.status_code} for "
                            f"board {board_id!r}: {response.text[:200]}"
                        ),
                    )
                try:
                    names = response.json()
                except ValueError as exc:
                    raise HTTPException(
                        status_code=502,
                        detail=f"Image-names endpoint for board {board_id!r} did not return JSON",
                    ) from exc
                if not isinstance(names, list):
                    raise HTTPException(
                        status_code=502,
                        detail=f"Image-names endpoint for board {board_id!r} returned an unexpected shape",
                    )
                all_names.extend(str(name) for name in names)
    except httpx.RequestError as exc:
        logger.warning("InvokeAI image-names request failed: %s", exc)
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach InvokeAI backend at {base_url}: {exc}",
        ) from exc

    # An image can belong to only one board, but guard against overlapping
    # selections (e.g. "none" plus a board) — dedupe preserving order.
    return list(dict.fromkeys(all_names))


async def delete_image(
    base_url: str,
    image_name: str,
    username: str | None,
    password: str | None,
) -> None:
    """Delete ``image_name`` on the InvokeAI backend.

    A 404 means InvokeAI no longer knows the image — log and return so the
    caller can still drop it from the local index.  Any other failure
    raises 502.
    """
    url = f"{base_url.rstrip('/')}/api/v1/images/i/{image_name}"
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:

            async def _do(headers: dict[str, str]) -> httpx.Response:
                return await client.delete(url, headers=headers)

            response = await _request_with_auth_fallback(
                base_url, username, password, _do
            )
    except httpx.RequestError as exc:
        logger.warning("InvokeAI image delete request failed: %s", exc)
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach InvokeAI backend at {base_url}: {exc}",
        ) from exc

    if response.status_code == 404:
        logger.warning(
            "InvokeAI no longer has image %s; removing from index anyway",
            image_name,
        )
        return
    if response.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=(
                f"InvokeAI image delete returned {response.status_code}: "
                f"{response.text[:200]}"
            ),
        )
