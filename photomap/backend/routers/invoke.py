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

When the configured InvokeAI backend runs in multi-user mode, the
``username`` / ``password`` fields are used to obtain a JWT bearer token
via ``/api/v1/auth/login``.  The token is cached in-process and
automatically refreshed on 401.  If the backend has since been
reconfigured into single-user mode it will reject a token-bearing
request with a 403 — that causes the cached token to be discarded and
the call to be retried anonymously without requiring a restart.
"""

from __future__ import annotations

import logging
import mimetypes
import re
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from urllib.parse import urlsplit

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
    """Cheap structural check for InvokeAI-shaped PNG metadata.

    Mirrors the detection used in ``metadata_formatting.py`` so the two code
    paths agree on what "this looks like an Invoke image" means.
    """
    if not raw_metadata:
        return False
    return (
        "app_version" in raw_metadata
        or "generation_mode" in raw_metadata
        or "canvas_v2_metadata" in raw_metadata
    )


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


def _validate_invokeai_url(url: str | None) -> str | None:
    """Reject non-http(s) schemes so configured URLs cannot be used for SSRF.

    The configured URL is later concatenated into outbound requests for
    ``/status``, ``/boards``, ``/recall`` and ``/use_ref_image``; ``httpx``
    already refuses non-http(s) schemes, but validating up front returns
    a clean 400 to the settings panel rather than a 502 at call time, and
    blocks obviously-wrong values like ``file://`` or ``javascript:`` from
    ever reaching the config file.

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
    """Payload posted by the drawer's "Use Ref Image" button."""

    album_key: str = Field(..., description="Album containing the image")
    index: int = Field(..., ge=0, description="Image index within the album")
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
    base_url = settings["url"]
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

    boards_url = f"{base_url.rstrip('/')}/api/v1/boards/"
    username = settings["username"]
    password = settings["password"]

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
    return Path(str(filenames[index]))


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

    image_path = _load_image_path(request.album_key, request.index)
    if not image_path.is_file():
        raise HTTPException(
            status_code=404, detail=f"Image file not found on disk: {image_path.name}"
        )

    # The existence probe is only worthwhile when there's a plausible chance
    # the file came from InvokeAI in the first place: the on-disk filename
    # still matches InvokeAI's ``{uuid}.{ext}`` convention, or the PNG
    # carries Invoke generation metadata.  Loading the metadata here is the
    # same lookup used by /invokeai/recall, so it's cheap and local.
    raw_metadata = _load_raw_metadata(request.album_key, request.index)
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

            async def _do_recall(headers: dict[str, str]) -> httpx.Response:
                return await client.post(recall_url, json=payload, headers=headers)

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
