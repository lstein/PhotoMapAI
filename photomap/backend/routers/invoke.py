"""Router for integration with a running InvokeAI backend.

Provides:

* ``GET /invokeai/config`` / ``POST /invokeai/config`` — view and update the
  InvokeAI connection settings stored in the PhotoMap config file.
* ``POST /invokeai/recall`` — take an (album_key, image index, include_seed)
  tuple, load the image metadata, build a recall payload from it, and proxy
  it to the configured InvokeAI backend's ``/api/v1/recall/{queue_id}``
  endpoint.

When the configured InvokeAI backend runs in multi-user mode, the
``username`` / ``password`` fields are used to obtain a JWT bearer token
via ``/api/v1/auth/login``.  The token is cached in-process and
automatically refreshed on 401.
"""

from __future__ import annotations

import logging
import time

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, ValidationError

from ..config import get_config_manager
from ..metadata_modules.invoke.invoke_metadata_view import InvokeMetadataView
from ..metadata_modules.invokemetadata import GenerationMetadataAdapter
from .album import get_embeddings_for_album

logger = logging.getLogger(__name__)

invoke_router = APIRouter(prefix="/invokeai", tags=["InvokeAI"])

# 5 seconds is plenty for a local loopback call; anything slower almost
# certainly means the backend is unreachable rather than genuinely busy.
_HTTP_TIMEOUT = 5.0

config_manager = get_config_manager()

# ── InvokeAI JWT token cache ──────────────────────────────────────────
_cached_token: str | None = None
_token_expires_at: float = 0.0
_token_base_url: str | None = None
_token_username: str | None = None


async def _get_auth_headers(base_url: str, username: str | None, password: str | None) -> dict[str, str]:
    """Return an ``Authorization`` header dict, or empty dict for single-user mode.

    Obtains (and caches) a JWT bearer token from the InvokeAI backend when
    credentials are provided.  The cached token is reused until it expires or
    the backend / username change.
    """
    global _cached_token, _token_expires_at, _token_base_url, _token_username  # noqa: PLW0603

    if not username or not password:
        return {}

    # Reuse cached token if still valid for this backend+user
    if (
        _cached_token
        and time.monotonic() < _token_expires_at
        and _token_base_url == base_url
        and _token_username == username
    ):
        return {"Authorization": f"Bearer {_cached_token}"}

    # Obtain a fresh token
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
    global _cached_token, _token_expires_at  # noqa: PLW0603
    _cached_token = None
    _token_expires_at = 0.0


class InvokeAISettings(BaseModel):
    """Mirrors the three config fields we expose via the settings panel."""

    url: str | None = None
    username: str | None = None
    password: str | None = None


class RecallRequest(BaseModel):
    """Payload posted by the drawer's recall / remix buttons."""

    album_key: str = Field(..., description="Album containing the image")
    index: int = Field(..., ge=0, description="Image index within the album")
    include_seed: bool = Field(
        True,
        description="If False, omit the seed from the recall payload (remix mode)",
    )
    queue_id: str = Field("default", description="InvokeAI queue id to target")


@invoke_router.get("/config")
async def get_invokeai_config() -> dict:
    """Return the persisted InvokeAI connection settings.

    The password is never returned in the clear — we only indicate whether
    one is stored.
    """
    settings = config_manager.get_invokeai_settings()
    return {
        "url": settings["url"] or "",
        "username": settings["username"] or "",
        "has_password": bool(settings["password"]),
    }


@invoke_router.post("/config")
async def set_invokeai_config(settings: InvokeAISettings) -> dict:
    """Persist the InvokeAI connection settings.

    A password of ``None`` leaves the existing stored password untouched so
    the settings panel can re-submit without clobbering what was saved.
    """
    _invalidate_token_cache()
    existing = config_manager.get_invokeai_settings()
    password = settings.password if settings.password is not None else existing["password"]
    try:
        config_manager.set_invokeai_settings(
            url=settings.url,
            username=settings.username,
            password=password,
        )
    except Exception as exc:
        logger.exception("Failed to persist InvokeAI settings")
        raise HTTPException(
            status_code=500, detail=f"Failed to save settings: {exc}"
        ) from exc
    return {"success": True}


def _load_raw_metadata(album_key: str, index: int) -> dict:
    embeddings = get_embeddings_for_album(album_key)
    if not embeddings:
        raise HTTPException(status_code=404, detail="Album not found")
    indexes = embeddings.indexes
    metadata = indexes["sorted_metadata"]
    if index < 0 or index >= len(metadata):
        raise HTTPException(status_code=404, detail="Index out of range")
    entry = metadata[index]
    return entry if isinstance(entry, dict) else {}


def _build_recall_payload(raw_metadata: dict, include_seed: bool) -> dict:
    if not raw_metadata:
        raise HTTPException(
            status_code=400, detail="No InvokeAI metadata available for this image"
        )
    try:
        parsed = GenerationMetadataAdapter().parse(raw_metadata)
    except ValidationError as exc:
        logger.warning("Failed to parse invoke metadata for recall: %s", exc)
        raise HTTPException(
            status_code=400, detail="Image does not contain recognizable InvokeAI metadata"
        ) from exc
    view = InvokeMetadataView(parsed)
    return view.to_recall_payload(include_seed=include_seed)


@invoke_router.post("/recall")
async def recall_parameters(request: RecallRequest) -> dict:
    """Forward a parsed recall payload to the configured InvokeAI backend.

    When the backend runs in multi-user mode and credentials are configured,
    a JWT bearer token is obtained (and cached) automatically.  A 401 from
    the recall endpoint triggers a single re-authentication attempt.
    """
    settings = config_manager.get_invokeai_settings()
    base_url = settings["url"]
    if not base_url:
        raise HTTPException(
            status_code=400,
            detail=(
                "InvokeAI backend URL is not configured. Set it in the "
                "PhotoMap settings panel."
            ),
        )

    raw_metadata = _load_raw_metadata(request.album_key, request.index)
    payload = _build_recall_payload(raw_metadata, include_seed=request.include_seed)
    if not payload:
        raise HTTPException(
            status_code=400,
            detail="No recallable parameters were found in this image's metadata",
        )

    url = f"{base_url.rstrip('/')}/api/v1/recall/{request.queue_id}"
    username = settings["username"]
    password = settings["password"]

    auth_headers = await _get_auth_headers(base_url, username, password)

    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            response = await client.post(url, json=payload, params={"strict": "true"}, headers=auth_headers)

            # Retry once on 401 with a fresh token
            if response.status_code == 401 and username and password:
                _invalidate_token_cache()
                auth_headers = await _get_auth_headers(base_url, username, password)
                response = await client.post(url, json=payload, params={"strict": "true"}, headers=auth_headers)
    except httpx.RequestError as exc:
        logger.warning("InvokeAI recall request failed: %s", exc)
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach InvokeAI backend at {base_url}: {exc}",
        ) from exc

    if response.status_code >= 400:
        logger.warning(
            "InvokeAI recall returned %s: %s", response.status_code, response.text
        )
        raise HTTPException(
            status_code=502,
            detail=(
                f"InvokeAI backend returned {response.status_code}: {response.text[:200]}"
            ),
        )

    try:
        remote = response.json()
    except ValueError:
        remote = {"raw": response.text}

    return {
        "success": True,
        "sent": payload,
        "response": remote,
    }
