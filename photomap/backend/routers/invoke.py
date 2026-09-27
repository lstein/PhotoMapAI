"""Router for integration with a running InvokeAI backend.

Provides:

* ``GET /invokeai/config`` / ``POST /invokeai/config`` — view and update the
  InvokeAI connection settings stored in the PhotoMap config file.
* ``POST /invokeai/recall`` — take an (album_key, image index, include_seed)
  tuple, load the image metadata, build a recall payload from it, and proxy
  it to the configured InvokeAI backend's ``/api/v1/recall/{queue_id}``
  endpoint.
* ``POST /invokeai/use_ref_image`` — upload the selected image to InvokeAI
  and then call the same recall endpoint with the uploaded image as a
  reference image parameter, so the next generation uses it for visual
  guidance.
* ``POST /invokeai/video/recall`` — the video counterpart of ``/recall``:
  send a video generation record to InvokeAI 7's
  ``/api/v1/recall/video/{queue_id}``.
* ``POST /invokeai/video/use_media`` — place a video in InvokeAI 7's Video
  panel as the Initial Video, or append it to the reference videos,
  uploading it first when InvokeAI does not already have it.

When the configured InvokeAI backend runs in multi-user mode, the
``username`` / ``password`` fields are used to obtain a JWT bearer token
via ``/api/v1/auth/login``.  The token is cached in-process and
automatically refreshed on 401.  If the backend has since been
reconfigured into single-user mode it will reject a token-bearing
request with a 403 — that causes the cached token to be discarded and
the call to be retried anonymously without requiring a restart.
"""

from __future__ import annotations

import asyncio
import logging
import mimetypes
import re
import time
from pathlib import Path
from typing import Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, ValidationError

from .. import invokeai_client
from ..config import get_config_manager
from ..invokeai_client import (  # noqa: F401  (re-exported for tests/backward compat)
    _HTTP_TIMEOUT,
    _invalidate_token_cache,
    _request_with_auth_fallback,
    _validate_invokeai_url,
)
from ..media_types import is_video
from ..metadata_modules.invoke.invoke_metadata_view import InvokeMetadataView
from ..metadata_modules.invoke.video_recall import (
    MEDIA_FIELDS,
    build_video_recall_payload,
    is_recallable_video_record,
)
from ..metadata_modules.invokemetadata import (
    GenerationMetadataAdapter,
    looks_like_invoke_metadata,
)
from ..video import VIDEO_METADATA_KEY
from .album import get_embeddings_for_album, require_no_lock

logger = logging.getLogger(__name__)

invoke_router = APIRouter(prefix="/invokeai", tags=["InvokeAI"])

config_manager = get_config_manager()

# ── InvokeAI capability cache ─────────────────────────────────────────
#
# Whether the configured backend supports the recall API at all, and the
# ``append`` reference-image option, is probed from its OpenAPI schema (or,
# failing that, inferred from its version).  The result gates which recall
# buttons the frontend reveals.  A successful probe is cached for several
# minutes; a failed one only briefly, so a backend that comes up (or gets
# upgraded) is noticed quickly.
_CAPS_TTL_OK = 300.0
_CAPS_TTL_ERROR = 30.0
# Version fallbacks, used only when the OpenAPI schema can't be fetched:
# the recall router shipped in 6.13.0, the append option in 6.13.5.
_RECALL_MIN_VERSION = (6, 13, 0)
_APPEND_MIN_VERSION = (6, 13, 5)

_caps_cache: dict | None = None
_caps_expires_at: float = 0.0
_caps_base_url: str | None = None


def _invalidate_capabilities_cache() -> None:
    """Clear the cached capabilities so the next request re-probes."""
    global _caps_cache, _caps_expires_at, _caps_base_url  # noqa: PLW0603
    _caps_cache = None
    _caps_expires_at = 0.0
    _caps_base_url = None


def _parse_version_tuple(version: str) -> tuple[int, ...] | None:
    """Extract the leading dotted-numeric part of a version string.

    Handles plain releases ("6.13.0"), post/dev suffixes ("6.13.0.post1",
    "6.14.0.dev5+g1a2b3c") and release candidates ("6.13.5rc1") by simply
    stopping at the first non-numeric component.
    """
    match = re.match(r"(\d+(?:\.\d+)*)", version.strip())
    if not match:
        return None
    return tuple(int(part) for part in match.group(1).split("."))


# InvokeAI stores images on disk as ``{uuid}.{ext}``; a filename matching this
# shape is a strong signal the file was originally produced by InvokeAI and
# therefore a candidate for the "already uploaded?" probe.
_INVOKE_UUID_FILENAME_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$",
    re.IGNORECASE,
)


def _looks_like_invoke_filename(name: str) -> bool:
    return bool(_INVOKE_UUID_FILENAME_RE.match(name))


def _has_invoke_metadata(raw_metadata: dict) -> bool:
    """Cheap structural check for InvokeAI-shaped metadata.

    Thin alias kept for the existing call sites and tests; the detection
    itself is shared with the drawer formatters so the paths cannot drift.
    """
    return looks_like_invoke_metadata(raw_metadata)


async def _invokeai_image_exists(
    client: httpx.AsyncClient,
    base_url: str,
    image_name: str,
    username: str | None,
    password: str | None,
) -> bool:
    """Return True iff InvokeAI confirms it already has ``image_name``.

    Probes ``GET /api/v1/images/i/{image_name}`` through the same auth
    fallback used elsewhere so it works in single- and multi-user modes.
    Any error — network, auth, unexpected status — is swallowed and treated
    as "not present" so the existence check can never make use_ref_image
    fail in a case that would otherwise have succeeded via upload.
    """
    url = f"{base_url.rstrip('/')}/api/v1/images/i/{image_name}"

    async def _do(headers: dict[str, str]) -> httpx.Response:
        return await client.get(url, headers=headers)

    try:
        resp = await _request_with_auth_fallback(base_url, username, password, _do)
    except (httpx.RequestError, HTTPException) as exc:
        logger.debug("InvokeAI existence check for %s failed: %s", image_name, exc)
        return False
    return resp.status_code == 200


# InvokeAI queue ids are short opaque tokens (e.g. ``default``); restrict
# the pattern so a caller can't splice ``../`` into the outbound URL path
# and reach an arbitrary endpoint on the configured backend.
_QUEUE_ID_PATTERN = r"^[A-Za-z0-9_.-]{1,64}$"


class InvokeAISettings(BaseModel):
    """Mirrors the config fields we expose via the settings panel."""

    url: str | None = None
    username: str | None = None
    password: str | None = None
    board_id: str | None = None


class RecallRequest(BaseModel):
    """Payload posted by the drawer's recall / remix buttons."""

    album_key: str = Field(..., description="Album containing the image")
    index: int = Field(..., ge=0, description="Image index within the album")
    include_seed: bool = Field(
        True,
        description="If False, omit the seed from the recall payload (remix mode)",
    )
    queue_id: str = Field(
        "default",
        description="InvokeAI queue id to target",
        pattern=_QUEUE_ID_PATTERN,
    )


class UseRefImageRequest(BaseModel):
    """Payload posted by the drawer's "Send to InvokeAI" / "Append to InvokeAI" buttons."""

    album_key: str = Field(..., description="Album containing the image")
    index: int = Field(..., ge=0, description="Image index within the album")
    append: bool = Field(
        False,
        description=(
            "If True, ask InvokeAI to append the image to its existing "
            "reference-image list instead of replacing it"
        ),
    )
    queue_id: str = Field(
        "default",
        description="InvokeAI queue id to target",
        pattern=_QUEUE_ID_PATTERN,
    )


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
        "board_id": settings["board_id"] or "",
    }


@invoke_router.post("/config")
async def set_invokeai_config(settings: InvokeAISettings) -> dict:
    """Persist the InvokeAI connection settings.

    A password or board_id of ``None`` leaves the existing stored value
    untouched so the settings panel can PATCH individual fields without
    clobbering what was saved.  Send an empty string to explicitly clear.
    """
    url = _validate_invokeai_url(settings.url)
    _invalidate_token_cache()
    _invalidate_capabilities_cache()
    existing = config_manager.get_invokeai_settings()
    password = settings.password if settings.password is not None else existing["password"]
    board_id = settings.board_id if settings.board_id is not None else existing["board_id"]
    try:
        config_manager.set_invokeai_settings(
            url=url,
            username=settings.username,
            password=password,
            board_id=board_id,
        )
    except Exception as exc:
        logger.exception("Failed to persist InvokeAI settings")
        raise HTTPException(
            status_code=500, detail=f"Failed to save settings: {exc}"
        ) from exc
    return {"success": True}


@invoke_router.get("/status")
async def invokeai_status() -> dict:
    """Report whether the configured URL is reachable and looks like InvokeAI.

    Probes the unauthenticated ``/api/v1/app/version`` endpoint.  A successful
    JSON response with a ``version`` field is the signal the settings UI uses
    to reveal the username/password/board rows.  Returns
    ``{"reachable": False, "detail": ...}`` for any network or HTTP failure
    rather than raising, so the frontend can render a neutral hint instead of
    an error banner while the user is still typing.
    """
    settings = config_manager.get_invokeai_settings()
    return await invokeai_client.check_status(settings["url"])


async def _probe_capabilities(
    client: httpx.AsyncClient,
    base_url: str,
    username: str | None,
    password: str | None,
) -> dict:
    """Determine which recall features the backend supports.

    Primary signal is the backend's OpenAPI schema: the presence of the
    ``/api/v1/recall/{queue_id}`` POST operation means the recall router
    exists, and an ``append`` entry in its query parameters means the
    append option is understood.  Probing the schema rather than comparing
    versions keeps development builds working — a backend running from a
    feature branch advertises the capability the moment the route exists,
    whatever its version string says.

    If the schema can't be fetched (older deployments may not serve it, or
    a proxy may block it), fall back to version thresholds via
    ``/api/v1/app/version``: recall shipped in 6.13.0, append in 6.13.5.

    The video recall router (``/api/v1/recall/video/{queue_id}``, InvokeAI 7)
    is detected from the schema only.

    Returns ``{"reachable": bool, "recall": bool, "append": bool,
    "video_recall": bool, "source": "openapi" | "version" | "unreachable"}``.
    """
    openapi_url = f"{base_url.rstrip('/')}/openapi.json"

    async def _do(headers: dict[str, str]) -> httpx.Response:
        return await client.get(openapi_url, headers=headers)

    try:
        resp = await _request_with_auth_fallback(base_url, username, password, _do)
        if resp.status_code == 200:
            spec = resp.json()
            recall_post = (
                spec.get("paths", {}).get("/api/v1/recall/{queue_id}", {}).get("post")
            )
            video_recall = (
                spec.get("paths", {})
                .get("/api/v1/recall/video/{queue_id}", {})
                .get("post")
                is not None
            )
            if recall_post is None:
                return {
                    "reachable": True,
                    "recall": False,
                    "append": False,
                    "video_recall": video_recall,
                    "source": "openapi",
                }
            params = {
                param.get("name") for param in recall_post.get("parameters", [])
            }
            return {
                "reachable": True,
                "recall": True,
                "append": "append" in params,
                "video_recall": video_recall,
                "source": "openapi",
            }
    except (httpx.RequestError, HTTPException, ValueError) as exc:
        logger.debug("InvokeAI OpenAPI capability probe failed: %s", exc)

    # Fallback: infer support from the version number.
    version_url = f"{base_url.rstrip('/')}/api/v1/app/version"
    version: str | None = None
    try:
        resp = await client.get(version_url)
        if resp.status_code == 200:
            version = resp.json().get("version")
    except (httpx.RequestError, ValueError) as exc:
        logger.debug("InvokeAI version capability probe failed: %s", exc)

    version_tuple = _parse_version_tuple(version) if version else None
    if version_tuple:
        return {
            "reachable": True,
            "recall": version_tuple >= _RECALL_MIN_VERSION,
            "append": version_tuple >= _APPEND_MIN_VERSION,
            # No release ships the video recall router yet, so there is no
            # version to infer it from: only the schema can advertise it.
            "video_recall": False,
            "source": "version",
            "version": version,
        }
    return {
        "reachable": False,
        "recall": False,
        "append": False,
        "video_recall": False,
        "source": "unreachable",
    }


@invoke_router.get("/capabilities")
async def invokeai_capabilities(refresh: bool = False) -> dict:
    """Report which recall features the configured backend supports.

    The frontend calls this once at startup (and after the InvokeAI settings
    change) and reveals only the recall buttons the backend can honor:

    * no recall router — no recall buttons at all;
    * recall without append — Send to InvokeAI / Remix / Recall, but no
      Append (an old backend would silently treat append as replace);
    * recall with append — all buttons.

    Results are cached per configured URL; pass ``?refresh=true`` to force a
    re-probe (used right after the settings are saved).
    """
    global _caps_cache, _caps_expires_at, _caps_base_url  # noqa: PLW0603

    settings = config_manager.get_invokeai_settings()
    base_url = settings["url"]
    if not base_url:
        return {
            "configured": False,
            "reachable": False,
            "recall": False,
            "append": False,
            "video_recall": False,
        }

    now = time.monotonic()
    if (
        not refresh
        and _caps_cache is not None
        and _caps_base_url == base_url
        and now < _caps_expires_at
    ):
        return _caps_cache

    async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
        probed = await _probe_capabilities(
            client, base_url, settings["username"], settings["password"]
        )

    capabilities = {"configured": True, **probed}
    _caps_cache = capabilities
    _caps_base_url = base_url
    _caps_expires_at = now + (_CAPS_TTL_OK if probed["reachable"] else _CAPS_TTL_ERROR)
    return capabilities


@invoke_router.get("/boards")
async def invokeai_boards() -> list[dict]:
    """Return the list of boards from the configured InvokeAI backend.

    Uses the same auth-fallback pattern as the recall and upload endpoints.
    Returns a flat ``[{"board_id": ..., "board_name": ...}]`` list — the
    frontend populates its dropdown directly from this.  Any failure
    (unreachable, auth, 5xx) raises 502; the frontend then renders a
    disabled "Uncategorized" option.
    """
    settings = config_manager.get_invokeai_settings()
    base_url = settings["url"]
    if not base_url:
        raise HTTPException(
            status_code=400, detail="InvokeAI backend URL is not configured."
        )
    return await invokeai_client.list_boards(
        base_url, settings["username"], settings["password"]
    )


class ProbeStatusRequest(BaseModel):
    """Connection probe for a URL that may not be saved in settings yet."""

    url: str


class ProbeBoardsRequest(BaseModel):
    """Board listing for per-album connection values from the album form."""

    url: str
    username: str | None = None
    password: str | None = None
    # Edit flow: the form never receives the stored album password, so it
    # sends the album key instead and we look the password up server-side.
    album_key: str | None = None


@invoke_router.post("/probe_status", dependencies=[Depends(require_no_lock)])
async def probe_invokeai_status(request: ProbeStatusRequest) -> dict:
    """Like ``GET /invokeai/status`` but for an explicit, possibly-unsaved URL.

    Used by the album form to validate a per-album InvokeAI URL before the
    album exists.
    """
    _validate_invokeai_url(request.url)
    return await invokeai_client.check_status(request.url)


@invoke_router.post("/probe_boards", dependencies=[Depends(require_no_lock)])
async def probe_invokeai_boards(request: ProbeBoardsRequest) -> list[dict]:
    """Like ``GET /invokeai/boards`` but for explicit connection values.

    Password resolution: an explicit password wins; otherwise fall back to
    the named album's stored password, then to the global settings password
    when the URL matches the globally-configured backend.
    """
    _validate_invokeai_url(request.url)
    if not request.url:
        raise HTTPException(
            status_code=400, detail="InvokeAI backend URL is required."
        )

    username = request.username
    password = request.password
    # A stored password is only ever paired with its own username: if the
    # caller typed a *different* username, the fallbacks don't apply and
    # the request proceeds without a password (failing cleanly upstream)
    # rather than submitting someone else's credentials.
    if not password and request.album_key:
        album = config_manager.get_albums().get(request.album_key)
        if (
            album is not None
            and album.invokeai_password
            and (not username or username == album.invokeai_username)
        ):
            password = album.invokeai_password
            username = album.invokeai_username
    if not password:
        settings = config_manager.get_invokeai_settings()
        if (
            settings["url"]
            and settings["url"].rstrip("/") == request.url.rstrip("/")
            and (not username or username == settings["username"])
        ):
            password = settings["password"]
            username = settings["username"]

    return await invokeai_client.list_boards(request.url, username, password)


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


def _load_image_path(album_key: str, index: int) -> Path:
    embeddings = get_embeddings_for_album(album_key)
    if not embeddings:
        raise HTTPException(status_code=404, detail="Album not found")
    indexes = embeddings.indexes
    filenames = indexes["sorted_filenames"]
    if index < 0 or index >= len(filenames):
        raise HTTPException(status_code=404, detail="Index out of range")
    path = Path(str(filenames[index]))
    # The single choke point for both /recall and /use_ref_image, which upload
    # the file to InvokeAI as a reference image. InvokeAI's upload endpoint
    # takes images, so handing it an .mp4 would surface as an opaque 502
    # carrying raw upstream text. The drawer already withholds the button for
    # videos; this closes the API path behind it.
    if is_video(path):
        raise HTTPException(
            status_code=400,
            detail="InvokeAI actions are not available for video files.",
        )
    return path


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
    if view.is_video_generation:
        # Belt to the path check's braces: a video record reaching here at
        # all means the file did not look like a video (renamed extension,
        # a container we do not classify), and recalling video parameters
        # into the image tab is wrong however the record arrived.
        raise HTTPException(
            status_code=400,
            detail="InvokeAI actions are not available for video generations.",
        )
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

    # For the 400 on videos. The result is unused — recall sends metadata,
    # never the file — but this is the guard, and it has to run before the
    # payload is built: a video's record parses as a v5 one (it *is* a v5
    # one), so nothing downstream would stop a video generation's prompt,
    # model, seed and cfg being posted to an endpoint that applies them to
    # the image tab. The drawer withholds the buttons; this closes the API
    # path behind them, as ``use_ref_image`` already does.
    await asyncio.to_thread(_load_image_path, request.album_key, request.index)
    raw_metadata = await asyncio.to_thread(
        _load_raw_metadata, request.album_key, request.index
    )
    payload = _build_recall_payload(raw_metadata, include_seed=request.include_seed)
    if not payload:
        raise HTTPException(
            status_code=400,
            detail="No recallable parameters were found in this image's metadata",
        )

    url = f"{base_url.rstrip('/')}/api/v1/recall/{request.queue_id}"
    username = settings["username"]
    password = settings["password"]

    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:

            async def _do(headers: dict[str, str]) -> httpx.Response:
                return await client.post(
                    url, json=payload, params={"strict": "true"}, headers=headers
                )

            response = await _request_with_auth_fallback(
                base_url, username, password, _do
            )
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


async def _upload_image_to_invokeai(
    client: httpx.AsyncClient,
    base_url: str,
    image_path: Path,
    username: str | None,
    password: str | None,
    board_id: str | None = None,
) -> tuple[str, str | None]:
    """Upload ``image_path`` to InvokeAI and return ``(image_name, warning)``.

    If ``board_id`` is provided, the upload targets that board.  If that
    attempt fails (board deleted, renamed, permission issue, etc.) the
    upload is retried without the board so the file lands in Uncategorized
    — that's the documented fallback behaviour.  When the fallback kicks in
    a human-readable warning is returned alongside the image name so the
    caller can surface it to the UI.

    Auth transitions (anonymous ↔ token) are handled transparently by
    ``_request_with_auth_fallback``; the multipart stream is re-opened on
    each retry since the previous one will have been consumed.
    """
    upload_url = f"{base_url.rstrip('/')}/api/v1/images/upload"
    mime_type = mimetypes.guess_type(image_path.name)[0] or "image/png"
    base_params = {"image_category": "user", "is_intermediate": "false"}

    async def _attempt(params: dict[str, str]) -> httpx.Response:
        async def _do(headers: dict[str, str]) -> httpx.Response:
            with image_path.open("rb") as fh:
                files = {"file": (image_path.name, fh, mime_type)}
                return await client.post(
                    upload_url, files=files, params=params, headers=headers
                )

        return await _request_with_auth_fallback(base_url, username, password, _do)

    warning: str | None = None
    if board_id:
        upload_resp = await _attempt({**base_params, "board_id": board_id})
        if upload_resp.status_code >= 400:
            logger.warning(
                "InvokeAI upload to board %s failed (%s); falling back to Uncategorized",
                board_id,
                upload_resp.status_code,
            )
            warning = (
                f"Upload to the selected board failed "
                f"(HTTP {upload_resp.status_code}); image was placed in Uncategorized."
            )
            upload_resp = await _attempt(base_params)
    else:
        upload_resp = await _attempt(base_params)

    if upload_resp.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=(
                f"InvokeAI image upload returned {upload_resp.status_code}: "
                f"{upload_resp.text[:200]}"
            ),
        )

    try:
        body = upload_resp.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=502,
            detail="InvokeAI image upload returned a non-JSON response",
        ) from exc

    image_name = body.get("image_name")
    if not image_name:
        raise HTTPException(
            status_code=502,
            detail="InvokeAI image upload response did not include image_name",
        )
    return image_name, warning


@invoke_router.post("/use_ref_image")
async def use_ref_image(request: UseRefImageRequest) -> dict:
    """Upload the selected image to InvokeAI and set it as a reference image.

    Implements the two-step flow: first ``POST /api/v1/images/upload`` so
    InvokeAI knows the file, then ``POST /api/v1/recall/{queue_id}`` with the
    returned ``image_name`` in ``reference_images`` so the next generation
    picks it up as visual guidance.

    With ``append=True`` the recall is sent with ``?append=true``, which asks
    InvokeAI to add the image to its existing reference-image list instead of
    replacing it (the drawer's "Append to InvokeAI" button).
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

    image_path = await asyncio.to_thread(
        _load_image_path, request.album_key, request.index
    )
    if not image_path.is_file():
        raise HTTPException(
            status_code=404, detail=f"Image file not found on disk: {image_path.name}"
        )

    # The existence probe is only worthwhile when there's a plausible chance
    # the file came from InvokeAI in the first place: the on-disk filename
    # still matches InvokeAI's ``{uuid}.{ext}`` convention, or the PNG
    # carries Invoke generation metadata.  Loading the metadata here is the
    # same lookup used by /invokeai/recall, so it's cheap and local.
    raw_metadata = await asyncio.to_thread(
        _load_raw_metadata, request.album_key, request.index
    )
    filename_matches = _looks_like_invoke_filename(image_path.name)
    metadata_matches = _has_invoke_metadata(raw_metadata)
    should_probe = filename_matches or metadata_matches

    username = settings["username"]
    password = settings["password"]
    board_id = settings["board_id"]

    recall_url = f"{base_url.rstrip('/')}/api/v1/recall/{request.queue_id}"

    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            board_warning: str | None = None
            reused_existing = False
            image_name: str | None = None
            if should_probe and await _invokeai_image_exists(
                client, base_url, image_path.name, username, password
            ):
                image_name = image_path.name
                reused_existing = True
                logger.info(
                    "Reusing existing InvokeAI image %s; skipping upload",
                    image_name,
                )
            else:
                image_name, board_warning = await _upload_image_to_invokeai(
                    client, base_url, image_path, username, password, board_id=board_id
                )

            # Deliberately omit ``strict=true`` so that the recall only
            # *adds* the reference image to whatever the user already has
            # set up in InvokeAI rather than resetting every other
            # parameter back to defaults.
            payload = {"reference_images": [{"image_name": image_name}]}
            recall_params = {"append": "true"} if request.append else None

            async def _do_recall(headers: dict[str, str]) -> httpx.Response:
                return await client.post(
                    recall_url, json=payload, params=recall_params, headers=headers
                )

            response = await _request_with_auth_fallback(
                base_url, username, password, _do_recall
            )
    except httpx.RequestError as exc:
        logger.warning("InvokeAI use_ref_image request failed: %s", exc)
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach InvokeAI backend at {base_url}: {exc}",
        ) from exc

    if response.status_code >= 400:
        logger.warning(
            "InvokeAI use_ref_image recall returned %s: %s",
            response.status_code,
            response.text,
        )
        raise HTTPException(
            status_code=502,
            detail=(
                f"InvokeAI backend returned {response.status_code}: "
                f"{response.text[:200]}"
            ),
        )

    try:
        remote = response.json()
    except ValueError:
        remote = {"raw": response.text}

    result = {
        "success": True,
        "sent": payload,
        "uploaded_image_name": image_name,
        "reused_existing": reused_existing,
        "response": remote,
    }
    if board_warning:
        result["warning"] = board_warning
    return result


# ── Video recall (InvokeAI 7) ──────────────────────────────────────────

# A video upload can take far longer than the 5 s used for everything else:
# InvokeAI converts anything that is not a browser-safe H.264 MP4 before it
# answers, and the file itself may be hundreds of megabytes.
_VIDEO_UPLOAD_TIMEOUT = httpx.Timeout(_HTTP_TIMEOUT, read=1800.0, write=1800.0)

_VIDEO_UPLOAD_ERRORS = {
    413: "The video is larger than InvokeAI's upload limit.",
    415: "InvokeAI could not read or convert this video.",
    429: "InvokeAI is busy with other uploads; try again shortly.",
}


class VideoRecallRequest(BaseModel):
    """Payload posted by the drawer's video Recall / Remix buttons."""

    album_key: str = Field(..., description="Album containing the video")
    index: int = Field(..., ge=0, description="Video index within the album")
    include_seed: bool = Field(
        True,
        description="If False, ask InvokeAI to keep its own seed (remix mode)",
    )
    queue_id: str = Field(
        "default",
        description="InvokeAI queue id to target",
        pattern=_QUEUE_ID_PATTERN,
    )


class VideoMediaRequest(BaseModel):
    """Payload posted by the drawer's "Initial Video" / "Ref Video" buttons."""

    album_key: str = Field(..., description="Album containing the video")
    index: int = Field(..., ge=0, description="Video index within the album")
    target: Literal["initial", "reference"] = Field(
        ...,
        description=(
            "``initial`` places the video in the Initial Video slot; "
            "``reference`` appends it to the reference videos"
        ),
    )
    queue_id: str = Field(
        "default",
        description="InvokeAI queue id to target",
        pattern=_QUEUE_ID_PATTERN,
    )


def _load_video_path(album_key: str, index: int) -> Path:
    """The mirror of ``_load_image_path``: only videos get through."""
    embeddings = get_embeddings_for_album(album_key)
    if not embeddings:
        raise HTTPException(status_code=404, detail="Album not found")
    filenames = embeddings.indexes["sorted_filenames"]
    if index < 0 or index >= len(filenames):
        raise HTTPException(status_code=404, detail="Index out of range")
    path = Path(str(filenames[index]))
    if not is_video(path):
        raise HTTPException(
            status_code=400,
            detail="This InvokeAI action is only available for video files.",
        )
    return path


def _video_record(raw_metadata: dict) -> dict:
    """The generation record alone, without PhotoMap's own probe results."""
    return {k: v for k, v in raw_metadata.items() if k != VIDEO_METADATA_KEY}


def _require_invokeai_url(settings: dict) -> str:
    base_url = settings["url"]
    if not base_url:
        raise HTTPException(
            status_code=400,
            detail=(
                "InvokeAI backend URL is not configured. Set it in the "
                "PhotoMap settings panel."
            ),
        )
    return base_url


def _json_or_raw(response: httpx.Response) -> dict:
    try:
        body = response.json()
    except ValueError:
        return {"raw": response.text}
    return body if isinstance(body, dict) else {"raw": body}


@invoke_router.post("/video/recall")
async def recall_video_parameters(request: VideoRecallRequest) -> dict:
    """Send a video's generation parameters to InvokeAI 7's Video panel.

    Always ``strict``: the record is a whole generation, so InvokeAI resets
    whatever the record does not set (LoRAs, media) instead of layering the
    recall over the panel's current state. Remix is ``mode=remix``, which
    InvokeAI implements by dropping the seed.
    """
    settings = config_manager.get_invokeai_settings()
    base_url = _require_invokeai_url(settings)

    await asyncio.to_thread(_load_video_path, request.album_key, request.index)
    raw_metadata = await asyncio.to_thread(
        _load_raw_metadata, request.album_key, request.index
    )
    record = _video_record(raw_metadata)
    if not is_recallable_video_record(record):
        raise HTTPException(
            status_code=400,
            detail="This video does not contain InvokeAI video generation metadata.",
        )
    payload = build_video_recall_payload(record)
    if not payload:
        raise HTTPException(
            status_code=400,
            detail="No recallable parameters were found in this video's metadata",
        )

    url = f"{base_url.rstrip('/')}/api/v1/recall/video/{request.queue_id}"
    params = {
        "mode": "recall" if request.include_seed else "remix",
        "strict": "true",
    }
    withheld: list[str] = []
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:

            async def _send(body: dict) -> httpx.Response:
                async def _do(headers: dict[str, str]) -> httpx.Response:
                    return await client.post(
                        url, json=body, params=params, headers=headers
                    )

                return await _request_with_auth_fallback(
                    base_url, settings["username"], settings["password"], _do
                )

            response = await _send(payload)
            # InvokeAI refuses the whole recall with a 403 when the record
            # names media the caller may not read (another user's clip on a
            # shared multi-user install). The prompt, models and settings are
            # still worth recalling, so try once more without the media.
            withheld = [field for field in MEDIA_FIELDS if field in payload]
            if response.status_code == 403 and withheld:
                payload = {k: v for k, v in payload.items() if k not in MEDIA_FIELDS}
                response = await _send(payload)
            else:
                withheld = []
    except httpx.RequestError as exc:
        logger.warning("InvokeAI video recall request failed: %s", exc)
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach InvokeAI backend at {base_url}: {exc}",
        ) from exc

    if response.status_code >= 400:
        logger.warning(
            "InvokeAI video recall returned %s: %s",
            response.status_code,
            response.text,
        )
        raise HTTPException(
            status_code=502,
            detail=(
                f"InvokeAI backend returned {response.status_code}: "
                f"{response.text[:200]}"
            ),
        )

    remote = _json_or_raw(response)
    status = remote.get("status", "success")
    skipped = remote.get("skipped") or []
    skipped = (skipped if isinstance(skipped, list) else []) + withheld
    result = {
        "success": status == "success",
        "status": status,
        "sent": payload,
        "skipped": skipped,
        "overridden": remote.get("overridden") or {},
        "response": remote,
    }
    if status == "nothing_resolved":
        result["message"] = (
            "None of this video's models or media were found on the linked "
            "InvokeAI, so nothing was recalled."
        )
    elif status == "no_parameters_provided":
        result["message"] = "InvokeAI found nothing to recall in this video's metadata."
    return result


async def _post_video_upload(
    client: httpx.AsyncClient,
    base_url: str,
    upload_url: str,
    video_path: Path,
    username: str | None,
    password: str | None,
    board_id: str | None,
) -> tuple[httpx.Response, str | None]:
    """Upload ``video_path`` through a ``/…-video/upload`` route.

    Like ``_upload_image_to_invokeai``, a failed upload to the configured
    board is retried without it (Uncategorized) and reported as a warning.
    Returns the final response and that warning.
    """
    mime_type = mimetypes.guess_type(video_path.name)[0] or "video/mp4"

    async def _attempt(params: dict[str, str]) -> httpx.Response:
        async def _do(headers: dict[str, str]) -> httpx.Response:
            # Re-opened per attempt: a retry needs a fresh stream.
            with video_path.open("rb") as fh:
                files = {"file": (video_path.name, fh, mime_type)}
                return await client.post(
                    upload_url, files=files, params=params, headers=headers
                )

        return await _request_with_auth_fallback(base_url, username, password, _do)

    response = await _attempt({"board_id": board_id} if board_id else {})
    # 403 (no write access) and 404 (board gone) are the board's fault;
    # a 413/415/429 would fail again without it.
    if board_id and response.status_code in (403, 404):
        logger.warning(
            "InvokeAI video upload to board %s failed (%s); falling back to Uncategorized",
            board_id,
            response.status_code,
        )
        warning = (
            f"Upload to the selected board failed (HTTP {response.status_code}); "
            "the video was placed in Uncategorized."
        )
        return await _attempt({}), warning
    return response, None


@invoke_router.post("/video/use_media")
async def use_video_media(request: VideoMediaRequest) -> dict:
    """Place a video in InvokeAI 7's Video panel.

    ``target="initial"`` makes it the Initial Video (the clip an extension
    continues); ``target="reference"`` appends it to the reference videos of
    whichever model takes them. Works for any video, generated or not.

    A video that may already be in InvokeAI's gallery (an InvokeAI-shaped
    filename or record) is first placed by name, which skips the upload; a
    refusal there (401/403/404) falls through to uploading the file.
    """
    settings = config_manager.get_invokeai_settings()
    base_url = _require_invokeai_url(settings)

    video_path = await asyncio.to_thread(
        _load_video_path, request.album_key, request.index
    )
    if not video_path.is_file():
        raise HTTPException(
            status_code=404, detail=f"Video file not found on disk: {video_path.name}"
        )
    raw_metadata = await asyncio.to_thread(
        _load_raw_metadata, request.album_key, request.index
    )
    should_probe = _looks_like_invoke_filename(video_path.name) or _has_invoke_metadata(
        _video_record(raw_metadata)
    )

    username = settings["username"]
    password = settings["password"]
    route = f"{base_url.rstrip('/')}/api/v1/recall/video/{request.queue_id}/{request.target}-video"

    board_warning: str | None = None
    reused_existing = False
    try:
        async with httpx.AsyncClient(timeout=_VIDEO_UPLOAD_TIMEOUT) as client:
            response: httpx.Response | None = None
            if should_probe:

                async def _by_name(headers: dict[str, str]) -> httpx.Response:
                    return await client.post(
                        route, params={"video_name": video_path.name}, headers=headers
                    )

                by_name = await _request_with_auth_fallback(
                    base_url, username, password, _by_name
                )
                # 404: not in the gallery. 403: not the caller's to read.
                # 401: credentials the upload's own auth fallback may yet
                # fix. Uploading gives the caller their own copy in each case.
                if by_name.status_code in (401, 403, 404):
                    logger.info(
                        "InvokeAI does not have %s (%s); uploading it",
                        video_path.name,
                        by_name.status_code,
                    )
                else:
                    response = by_name
                    reused_existing = response.status_code < 400
            if response is None:
                response, board_warning = await _post_video_upload(
                    client,
                    base_url,
                    f"{route}/upload",
                    video_path,
                    username,
                    password,
                    settings["board_id"],
                )
    except httpx.ReadTimeout as exc:
        # The upload itself went through; InvokeAI was still converting it.
        # It will most likely finish and place the video on its own, so say
        # so rather than invite a retry that would add a second copy.
        logger.warning("InvokeAI video %s timed out waiting for a reply: %s", request.target, exc)
        raise HTTPException(
            status_code=504,
            detail=(
                "InvokeAI is taking a long time to process this video. It may "
                "still appear in InvokeAI shortly; check there before trying again."
            ),
        ) from exc
    except httpx.RequestError as exc:
        logger.warning("InvokeAI video %s request failed: %s", request.target, exc)
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach InvokeAI backend at {base_url}: {exc}",
        ) from exc

    if response.status_code >= 400:
        logger.warning(
            "InvokeAI video %s returned %s: %s",
            request.target,
            response.status_code,
            response.text,
        )
        explanation = _VIDEO_UPLOAD_ERRORS.get(response.status_code)
        raise HTTPException(
            status_code=502,
            detail=explanation
            or (
                f"InvokeAI backend returned {response.status_code}: "
                f"{response.text[:200]}"
            ),
        )

    remote = _json_or_raw(response)
    video = remote.get("video")
    result = {
        "success": True,
        "target": request.target,
        "video_name": video.get("video_name") if isinstance(video, dict) else None,
        "reused_existing": reused_existing,
        "response": remote,
    }
    if board_warning:
        result["warning"] = board_warning
    return result
