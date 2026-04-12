"""Router for integration with a running InvokeAI backend.

Provides:

* ``GET /invokeai/config`` / ``POST /invokeai/config`` — view and update the
  InvokeAI connection settings stored in the PhotoMap config file.
* ``POST /invokeai/recall`` — take an (album_key, image index, include_seed)
  tuple, load the image metadata, build a recall payload from it, and proxy
  it to the configured InvokeAI backend's ``/api/v1/recall/{queue_id}``
  endpoint.

Authentication against a multi-user InvokeAI deployment is not implemented
yet — the ``username`` / ``password`` fields are persisted for future use
but currently unused when contacting the remote backend.
"""

from __future__ import annotations

import logging

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
    """Forward a parsed recall payload to the configured InvokeAI backend."""
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
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            response = await client.post(url, json=payload)
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
