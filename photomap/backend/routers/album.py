import asyncio
import logging
import os
import shutil
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError

from .. import invokeai_client
from ..cluster_eps import FALLBACK_CLUSTER_EPS, MIN_CLUSTER_EPS, cached_adaptive_cluster_eps
from ..config import (
    Album,
    create_album,
    default_board_index_path,
    get_config_manager,
)
from ..embeddings import Embeddings
from ..encoders import default_encoder_spec, default_min_search_score
from ..util import json_safe
from ..video_cache import VideoFrameCache


class UmapEpsSetRequest(BaseModel):
    album: str
    # None clears the album's stored Cluster Strength, putting it back to a
    # value derived from the album's own coordinates. Without this the UI
    # would be a one-way door: once a number is typed there is no way back
    # to the derived value short of editing the config file.
    #
    # A number, though, is constrained. The bound is MIN_CLUSTER_EPS rather
    # than a bare "positive" because that is the floor resolve_cluster_eps
    # applies before clustering: anything under it is stored and displayed as
    # one number while the map is drawn with another, which is the whole
    # failure this constraint exists to prevent. A non-finite one is worse
    # still — it cannot be serialized back out, so /get_umap_eps fails on its
    # own response. A 422 says no before anything is written.
    eps: float | None = Field(default=None, ge=MIN_CLUSTER_EPS, allow_inf_nan=False)


class UmapEpsGetRequest(BaseModel):
    album: str


class LocationIQSetRequest(BaseModel):
    key: str


# Initialize logging
logger = logging.getLogger(__name__)

album_router = APIRouter()
config_manager = get_config_manager()


def get_locked_albums() -> list[str] | None:
    """Get list of locked albums from environment variable.

    Returns:
        List of locked album keys, or None if no lock is set.
    """
    locked_albums_str = os.environ.get("PHOTOMAP_ALBUM_LOCKED")
    if not locked_albums_str:
        return None
    return [a.strip() for a in locked_albums_str.split(",")]


def check_album_lock(album_key: str | None = None):
    """Check if album operations are allowed based on lock settings.

    Args:
        album_key: Optional album key to check. If None, checks if any modifications are allowed.

    Raises:
        HTTPException: If the operation is not allowed due to album lock.
    """
    locked_albums = get_locked_albums()
    if locked_albums is None:
        return  # No lock is set

    if album_key and album_key not in locked_albums:
        logger.warning(
            f"Attempt to modify locked album configuration: {album_key} not in {locked_albums}"
        )
        raise HTTPException(
            status_code=403,
            detail=f"Album management is locked to album(s) '{','.join(locked_albums)}' in this deployment.",
        )

    elif not album_key:
        logger.warning("Attempt to modify locked album configuration")
        raise HTTPException(
            status_code=403,
            detail="Album management is locked in this deployment.",
        )


# ---------------------------------------------------------------------------
# Album / Embeddings access helpers
# ---------------------------------------------------------------------------


def validate_album_exists(album_key: str):
    """Validate that an album exists, raise HTTPException if not.
    Args:
        album_key: Album key to validate
    Returns:
        Album object if exists
    Raises:
        HTTPException: If album does not exist
    """
    check_album_lock(album_key)  # May raise a 403 exception
    album_config = config_manager.get_album(album_key)
    if not album_config:
        raise HTTPException(status_code=404, detail=f"Album '{album_key}' not found")
    return album_config


def get_embeddings_for_album(album_key: str) -> Embeddings:
    """Get embeddings instance for a given album."""
    check_album_lock(album_key)  # May raise a 403 exception
    album_config = validate_album_exists(album_key)
    return Embeddings(
        embeddings_path=Path(album_config.index),
        encoder_spec=album_config.encoder_spec,
        min_image_dimension=album_config.min_image_dimension,
        min_image_bytes=album_config.min_image_bytes,
        album_key=album_key,
    )


def album_umap_coords(embeddings: Embeddings):
    """An album's cached UMAP coordinates, or ``None`` if it has no index yet.

    Every eps-resolving endpoint needs these, and every one of them can be
    called on an album that is configured but not yet indexed — the semantic
    map is opened on exactly that album while its first index runs. Letting
    the ``FileNotFoundError`` out turns that into a 500 on a screen the user
    is watching indexing progress from.

    Blocking, and not always cheaply: ``umap_embeddings`` is a *rebuild* and
    not a read whenever ``umap.npz`` is missing or older than
    ``embeddings.npz``, which is the state any rewrite of the index leaves
    behind (an image delete, an ``update_images`` run). Async callers must go
    through :func:`album_umap_coords_async`.
    """
    try:
        return embeddings.umap_embeddings
    except FileNotFoundError:
        return None


async def album_umap_coords_async(embeddings: Embeddings):
    """:func:`album_umap_coords` off the event loop.

    Note this cannot be spelled ``asyncio.to_thread(f, album_umap_coords(e))``
    at the call site: the argument would be evaluated — and the UMAP possibly
    refitted, for minutes — before the thread is ever spawned.
    """
    return await asyncio.to_thread(album_umap_coords, embeddings)


def validate_image_access(album_config, image_path: Path) -> bool:
    """Validate that an image path is within allowed album directories.
    Args:
        album_config: Album configuration object
        image_path: Path to the image file
    Returns:
        True if access is allowed, False otherwise
    """
    # The resolve() calls shouldn't really be necessary here, but they fix problems arising
    # on mapped Windows network drive paths.
    check_album_lock(album_config.key)  # May raise a 403 exception

    # Reject symlinks outright. ``resolve()`` + ``is_relative_to`` already
    # blocks symlinks whose target lives outside the album, but a flat reject
    # also closes a TOCTOU window between this check and the eventual file
    # open, and shields against attacks that swap a regular file for a
    # symlink after indexing.
    try:
        if image_path.is_symlink():
            return False
    except OSError:
        return False

    return any(
        [
            image_path.resolve().is_relative_to(Path(p).resolve())
            for p in album_config.image_paths
        ]
    )


# ---------------------------------------------------------------------------
# FastAPI dependency types
# ---------------------------------------------------------------------------
# The three helpers above (``check_album_lock`` / ``validate_album_exists`` /
# ``get_embeddings_for_album``) are shaped like FastAPI dependencies — they
# take ``album_key: str`` (which FastAPI auto-binds from path parameters)
# and raise ``HTTPException`` on failure. Wrap them in ``Annotated`` aliases
# so endpoints can declare ``album: AlbumDep`` / ``embeddings: EmbeddingsDep``
# and get the validation + 403/404 handling for free, instead of repeating
# the three-line dance at every entry point.
#
# Both ``AlbumDep`` and ``EmbeddingsDep`` already include the album-specific
# lock check via the inner helpers. Endpoints that additionally need the
# "no lock at all" guard (destructive operations like delete_album,
# update_album, etc.) add ``dependencies=[Depends(require_no_lock)]`` to
# the route decorator.

AlbumDep = Annotated[Album, Depends(validate_album_exists)]
EmbeddingsDep = Annotated[Embeddings, Depends(get_embeddings_for_album)]


def require_no_lock() -> None:
    """Dependency that fails the request if any album lock is set.

    Used on routes that mutate global state (the YAML config, the filetree)
    where any lock setting should refuse the operation, regardless of which
    album is named.
    """
    check_album_lock()


def _cleanup_derived_index(album: Album | None) -> None:
    """Remove a board album's backend-derived index directory.

    Board-album indexes live in the per-user data directory
    (``.../indexes/<key>/``) rather than next to the images, so nothing
    else cleans them up when the album goes away. Only the derived
    location is touched — a custom index path is left alone.
    """
    if album is None or album.source_type != "invokeai_board":
        return
    try:
        derived_dir = default_board_index_path(album.key).parent
    except ValueError:
        return
    if Path(album.index).parent != derived_dir or not derived_dir.is_dir():
        return
    try:
        shutil.rmtree(derived_dir)
    except OSError as e:
        logger.warning(f"Could not remove index directory {derived_dir}: {e}")


def _cleanup_video_frames(album_key: str) -> None:
    """Remove an album's extracted video stills when the album goes away.

    The frame cache lives in the per-user cache directory, keyed by album, so
    nothing else would ever reclaim it. Never raises: a failure here costs
    disk space, not correctness.
    """
    try:
        VideoFrameCache(album_key).clear()
    except Exception as e:
        logger.warning(f"Could not clear video frame cache for '{album_key}': {e}")


def _album_public_dict(album: Album) -> dict[str, Any]:
    """Album fields as exposed to the frontend.

    Deliberately omits ``invokeai_password`` — the stored per-album password
    must never leave the backend. ``has_invokeai_password`` tells the edit
    form whether one is saved.
    """
    return {
        "key": album.key,
        "name": album.name,
        "description": album.description,
        "source_type": album.source_type,
        "index": album.index,
        "umap_eps": album.umap_eps,
        "image_paths": album.image_paths,
        "encoder_spec": album.encoder_spec,
        "min_search_score": album.min_search_score,
        "max_search_results": album.max_search_results,
        "use_query_optimization": album.use_query_optimization,
        "min_image_dimension": album.min_image_dimension,
        "min_image_bytes": album.min_image_bytes,
        "invokeai_url": album.invokeai_url,
        "invokeai_username": album.invokeai_username,
        "invokeai_root": album.invokeai_root,
        "invokeai_board_ids": album.invokeai_board_ids,
        "has_invokeai_password": bool(album.invokeai_password),
    }


# Album Management Routes
@album_router.get("/available_albums/", tags=["Albums"])
async def get_available_albums() -> list[dict[str, Any]]:
    """Get list of available albums."""
    try:
        albums = config_manager.get_albums()

        if not albums:
            return []

        locked_albums = get_locked_albums()

        return [
            _album_public_dict(album)
            for key, album in albums.items()
            if locked_albums is None or key in locked_albums
        ]
    except Exception as e:
        logger.error(f"Failed to get albums: {e}")
        return []


@album_router.get("/default_encoder/", tags=["Albums"])
async def get_default_encoder() -> dict[str, str]:
    """Return the encoder spec new albums should default to on this host.

    The default is platform-aware — CPU-only Linux/Windows hosts get a lighter
    encoder than CUDA/macOS hosts — so the frontend asks the server for it
    rather than hardcoding a single default in the dropdown.
    """
    return {"encoder_spec": default_encoder_spec()}


@album_router.get("/album/{album_key}/", tags=["Albums"])
async def get_album(album: AlbumDep) -> dict[str, Any]:
    """Get details of a specific album (passwords omitted)."""
    return _album_public_dict(album)


# TO DO: Replace album_data dict with a proper Pydantic model
@album_router.post(
    "/add_album/", tags=["Albums"], dependencies=[Depends(require_no_lock)]
)
async def add_album(album: Album) -> JSONResponse:
    """Add a new album to the configuration."""
    try:
        logging.info(f"Adding album: {album.key} with paths {album.image_paths}")
        if config_manager.add_album(album):
            return JSONResponse(
                content={
                    "success": True,
                    "message": f"Album '{album.key}' added successfully",
                },
                status_code=201,
            )
        else:
            raise HTTPException(
                status_code=409, detail=f"Album '{album.key}' already exists"
            )

    except Exception as e:
        logger.warning(f"Failed to add album: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to add album: {str(e)}") from e


@album_router.post(
    "/update_album/", tags=["Albums"], dependencies=[Depends(require_no_lock)]
)
async def update_album(album_data: dict) -> JSONResponse:
    """Update an existing album, keeping any field the payload leaves out.

    An update is a *patch*, not a replacement. Callers send partial payloads —
    the bookmark menu sends five keys, the search dialog sends the album plus
    three overrides — and rebuilding the album from those alone silently reset
    everything else to model defaults. The damage was worst for InvokeAI-board
    albums: ``source_type`` defaulted back to ``"directory"`` and the
    ``invokeai_*`` fields to None, quietly demoting the album, after which
    indexing walked InvokeAI's output directories directly and deletions
    stopped routing through its API (issue #371).

    So every field falls back to what is stored: a key the payload does not
    carry keeps its current value. Presence is what decides — a key that *is*
    present wins even when its value is falsy or null, because
    ``min_image_bytes: 0``, ``use_query_optimization: false``, an emptied
    description and ``invokeai_username: null`` are all real edits the UI
    sends.
    """
    try:
        existing = config_manager.get_album(album_data["key"])
        # Answered here rather than by the failed write at the end: with
        # patch semantics there is nothing to patch, and the half-built
        # Album that a partial payload produces raises out of create_album
        # as a 500 before the write is ever reached. Both shapes of payload
        # deserve the same 404.
        if existing is None:
            raise HTTPException(
                status_code=404, detail=f"Album '{album_data['key']}' not found"
            )

        def kept(field: str, default: Any = None) -> Any:
            """The payload's value for ``field``, else the stored one.

            Falsy is not absent: ``0``, ``false`` and ``""`` are real settings
            here and are honored. Null *is* treated as absent, because
            ``create_album`` turns a None into the model default rather than
            into a cleared field — so honoring it would reset an album's
            encoder or scan gates to factory values instead of clearing them.
            The one field that genuinely needs clearing is handled by
            :func:`cleared_or_kept`.
            """
            value = album_data.get(field)
            if value is not None:
                return value
            if existing is not None:
                return getattr(existing, field, default)
            return default

        def cleared_or_kept(field: str) -> Any:
            """Like :func:`kept`, but an explicit null clears the field.

            The edit form sends ``invokeai_username: null`` when the user
            empties the username box — InvokeAI dropped out of multi-user
            mode — and that has to stop the stored credentials being sent.
            """
            if field in album_data:
                return album_data[field]
            return getattr(existing, field, None) if existing else None

        # An album's kind is fixed at creation: the edit form branches on the
        # stored value and never offers to switch, so a payload that disagrees
        # is a partial payload being read as a replacement — the bug this
        # patch semantics exists to prevent (issue #371).
        requested_type = album_data.get("source_type")
        if (
            existing is not None
            and requested_type is not None
            and requested_type != existing.source_type
        ):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Album '{existing.key}' is a {existing.source_type} album; "
                    f"its source type cannot be changed by an update."
                ),
            )

        # The edit form never sees the saved InvokeAI password, so it sends a
        # blank one for "I did not touch this": "" means keep, unlike every
        # other field here. An explicit null is the form's *Forget saved
        # password* box — the only way to say "clear it", which a backend
        # leaving multi-user mode needs, since a stored password with no
        # username is dead weight the config keeps offering.
        if "invokeai_password" in album_data and album_data["invokeai_password"] is None:
            password = None
        else:
            password = album_data.get("invokeai_password") or (
                existing.invokeai_password if existing else None
            )
        is_board = kept("source_type", "directory") == "invokeai_board"
        # Only a change of encoder *band* invalidates a stored score. The
        # test is the resolved floor, not the spec: swapping one OpenCLIP
        # model for another shares a scale and must leave a hand-tuned value
        # alone, while OpenAI CLIP -> OpenCLIP moves the whole distribution
        # down by about 0.1 (see ``default_min_search_score``) and carrying
        # the old number over would judge the new encoder at a threshold
        # above most of its match band.
        score_band_changed = existing is not None and default_min_search_score(
            kept("encoder_spec", existing.encoder_spec)
        ) != default_min_search_score(existing.encoder_spec)
        album = create_album(
            key=album_data["key"],
            # Patched like every other field. Reading it straight out of the
            # payload contradicted the rule this endpoint documents, and a
            # payload without it raised a bare KeyError that surfaced as a
            # 500 whose detail was the word "name".
            name=kept("name"),
            # Board albums derive their directories from the InvokeAI root,
            # so theirs are never carried over: a non-empty list suppresses
            # that derivation, which would pin the album to its old root the
            # moment the user edits the root.
            image_paths=None if is_board else kept("image_paths"),
            # Falsy, not just absent: the edit form sends "" when an album has
            # no paths left to derive an index from, and an edit never
            # relocates an index anyway.
            index=album_data.get("index") or (existing.index if existing else None),
            # cleared_or_kept, not kept: absent means "keep the tuning",
            # but an explicit null is how an album is handed back to a
            # strength derived from its own coordinates. 0.07 is gone as a
            # fallback — "no value" now means "derive one".
            umap_eps=cleared_or_kept("umap_eps"),
            description=kept("description", ""),
            encoder_spec=kept("encoder_spec"),
            # Left to the model to re-resolve when the encoder family changed
            # and the payload said nothing: carrying the other family's floor
            # over makes the new encoder look like it returns nothing.
            # ``is None`` rather than ``not in``: ``kept`` treats a null as
            # absent, so testing presence made the two halves disagree — an
            # explicit null suppressed the re-resolve *and* fell through to
            # the stored value, leaving a CLIP floor on a SigLIP album, where
            # it matches nothing.
            min_search_score=(
                None
                if score_band_changed and album_data.get("min_search_score") is None
                else kept("min_search_score")
            ),
            max_search_results=kept("max_search_results"),
            use_query_optimization=kept("use_query_optimization"),
            min_image_dimension=kept("min_image_dimension"),
            min_image_bytes=kept("min_image_bytes"),
            source_type=kept("source_type", "directory"),
            invokeai_url=kept("invokeai_url"),
            invokeai_username=cleared_or_kept("invokeai_username"),
            invokeai_password=password,
            invokeai_root=kept("invokeai_root"),
            invokeai_board_ids=kept("invokeai_board_ids"),
        )

        # A board album's directories are derived from the InvokeAI root, not
        # chosen: an added folder would widen the album's file-access gate to
        # a directory InvokeAI knows nothing about, and the next index run
        # would ignore it anyway. Refusing out loud beats accepting the
        # request and quietly doing something else with it.
        #
        # Echoing back what the album already has is not a change, and there
        # are two such lists while a root edit is in flight: the stored one
        # and the one this request derives. Callers that GET an album and POST
        # it back — the search-settings persister does exactly that — send one
        # or the other depending on how the two raced, and neither is asking
        # for anything.
        requested_paths = album_data.get("image_paths")
        if (
            existing is not None
            and existing.source_type == "invokeai_board"
            and requested_paths is not None
        ):

            def _normalized(paths: list[str]) -> set[str]:
                # Normalized the way ``create_album`` stores them, so a
                # symlinked root echoed back does not read as a change. A path
                # that cannot be resolved at all (symlink loop, embedded NUL)
                # is left as-is: it will not match either list, which is the
                # 400 this guard exists to raise, not a 500.
                normalized = set()
                for path in paths:
                    try:
                        normalized.add(str(Path(path).expanduser().resolve()))
                    except Exception:
                        # Deliberately broad: what ``resolve()`` raises for an
                        # unresolvable path is interpreter-dependent (a symlink
                        # loop is a RuntimeError up to 3.12 and an OSError from
                        # 3.13, an embedded NUL a ValueError), and this project
                        # supports 3.10–3.13. Whatever it is, the path is not
                        # one of the album's own — leave it unnormalized so it
                        # falls through to the 400 rather than a 500.
                        normalized.add(str(path))
                return normalized

            # Sets, and subsets: this asks "is the caller requesting a
            # change", and a caller echoing back part of what the album has
            # is not. Order carries no meaning — nothing downstream depends
            # on it — and comparing lists made a reordered echo a 400.
            #
            # A subset counts because the derived list has grown: board
            # albums gained an ``outputs/videos`` directory alongside
            # ``outputs/images``, so a client still holding a snapshot from
            # before that sends one path where the album now has two. It is
            # asking for nothing, exactly like the caller mid-root-edit that
            # the second accepted list below exists for.
            requested = _normalized(requested_paths)
            unchanged = bool(requested) and (
                requested <= _normalized(existing.image_paths)
                or requested <= _normalized(album.image_paths)
            )
            if not unchanged:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "InvokeAI-board albums take their image directories "
                        "from the InvokeAI root; they cannot be changed or "
                        "added to."
                    ),
                )

        # The JWT cache is keyed on (url, username), neither of which has to
        # change when credentials do — so a password that was just cleared (or
        # replaced) would otherwise keep working from cache until the token
        # expired, up to a day later.
        credentials_changed = (
            album.invokeai_password != existing.invokeai_password
            or album.invokeai_username != existing.invokeai_username
            or album.invokeai_url != existing.invokeai_url
        )

        logger.info(f"Updating album: {album.key} with index {album.index}")

        if config_manager.update_album(album):
            # After the write, not before it. The cache is keyed on
            # (url, username) alone, so a request that reads the album in
            # between — an index scan, a board delete — logs in with the
            # *old* password and re-caches a token that then outlives the
            # change by up to a day, which is the thing this invalidation
            # exists to stop.
            if credentials_changed:
                invokeai_client._invalidate_token_cache()
            return JSONResponse(
                content={
                    "success": True,
                    "message": f"Album '{album.key}' updated successfully",
                },
                status_code=200,
            )
        else:
            raise HTTPException(
                status_code=404, detail=f"Album '{album.key}' not found"
            )

    except HTTPException:
        # A 400/404 raised above is the answer; wrapping it in a 500 would
        # bury the reason the update was refused.
        raise
    except ValidationError as e:
        # This endpoint takes a free-form dict rather than a request model, so
        # a field the Album model refuses — a Cluster Strength the map cannot
        # cluster with, say — surfaces here rather than as FastAPI's own 422.
        # It is still the caller's mistake, and it must not be reported as
        # success: /update_album silently dropping an unusable umap_eps is how
        # a client would end up believing it had stored one.
        detail = json_safe(jsonable_encoder(e.errors(include_url=False)))
        raise HTTPException(status_code=422, detail=detail) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update album: {str(e)}") from e


@album_router.delete(
    "/delete_album/{album_key}", tags=["Albums"], dependencies=[Depends(require_no_lock)]
)
async def delete_album(album_key: str) -> JSONResponse:
    """Delete an album from the configuration."""
    try:
        album = config_manager.get_album(album_key)
        if config_manager.delete_album(album_key):
            _cleanup_derived_index(album)
            _cleanup_video_frames(album_key)
            return JSONResponse(
                content={
                    "success": True,
                    "message": f"Album '{album_key}' deleted successfully",
                },
                status_code=200,
            )
        else:
            raise HTTPException(
                status_code=404, detail=f"Album '{album_key}' not found"
            )

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete album: {str(e)}") from e


# The LocationIQ API key for showing GPS locations
@album_router.get(
    "/locationiq_key/", tags=["Albums"], dependencies=[Depends(require_no_lock)]
)
async def get_locationiq_key():
    """Get the current LocationIQ API key (masked for security)."""
    api_key = config_manager.get_locationiq_api_key()
    if api_key:
        # Return masked version for security
        return {
            "has_key": True,
            "key": (
                "●" * (len(api_key) - 4) + api_key[-4:]
                if len(api_key) > 4
                else "●" * len(api_key)
            ),
        }
    return {"has_key": False, "key": ""}


@album_router.post(
    "/locationiq_key/", tags=["Albums"], dependencies=[Depends(require_no_lock)]
)
async def set_locationiq_key(request: LocationIQSetRequest):
    """Set the LocationIQ API key."""
    api_key = request.key
    try:
        config_manager.set_locationiq_api_key(api_key)
        # Force reload to ensure other parts of app see the change
        config_manager.reload_config()
        return {"success": True, "message": "API key updated successfully"}
    except Exception as e:
        return {"success": False, "message": str(e)}


@album_router.post(
    "/set_umap_eps/", tags=["Albums"], dependencies=[Depends(require_no_lock)]
)
async def set_umap_eps(request: UmapEpsSetRequest):
    """Store an album's Cluster Strength, or clear it back to derived.

    ``eps: null`` is the clear: the album stops carrying a number and
    ``/get_umap_eps`` starts deriving one again.
    """
    album_config = config_manager.get_album(request.album)
    if not album_config:
        raise HTTPException(status_code=404, detail="Album not found")
    album_config.umap_eps = request.eps
    config_manager.update_album(album_config)
    return {"success": True, "eps": request.eps}


@album_router.post("/get_umap_eps/", tags=["Albums"])
async def get_umap_eps(request: UmapEpsGetRequest):
    """The Cluster Strength value the semantic map should show for an album.

    Returns a number either way, plus ``auto`` saying where it came from: a
    stored ``umap_eps`` (the user has tuned this album) or one derived from
    the album's UMAP coordinates. The frontend fills its spinner from this
    and then passes the number explicitly to ``/umap_data`` and
    ``/cluster_labels``, so all three agree on the clustering without either
    of those endpoints having to resolve it a second time.

    Deriving costs a k-distance pass plus a handful of DBSCAN fits — seconds
    on a six-figure album — so it runs in a thread and is memoized on disk
    against the coordinates it was computed from.
    """
    check_album_lock(request.album)  # May raise a 403 exception
    album_config = config_manager.get_album(request.album)
    if not album_config:
        raise HTTPException(status_code=404, detail="Album not found")

    if album_config.umap_eps is not None:
        return {"success": True, "eps": album_config.umap_eps, "auto": False}

    coords = await album_umap_coords_async(get_embeddings_for_album(request.album))
    if coords is None or coords.shape[0] == 0:
        # Not indexed yet: nothing to derive from, and the map will be empty
        # regardless. The historical default keeps the spinner showing a
        # usable number rather than blank.
        return {"success": True, "eps": FALLBACK_CLUSTER_EPS, "auto": True}

    eps = await asyncio.to_thread(
        cached_adaptive_cluster_eps,
        coords,
        Path(album_config.index).parent,
    )
    return {"success": True, "eps": eps, "auto": True}


