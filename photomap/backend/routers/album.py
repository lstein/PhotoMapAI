import logging
import os
import shutil
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ..config import Album, create_album, default_board_index_path, get_config_manager
from ..embeddings import Embeddings
from ..encoders import default_encoder_spec


class UmapEpsSetRequest(BaseModel):
    album: str
    eps: float


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
    )


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
    """Update an existing album in the configuration."""
    try:
        existing = config_manager.get_album(album_data["key"])
        # Edits never relocate an index: when the payload omits it, keep the
        # stored path. Likewise the edit form never sees the saved InvokeAI
        # password, so a blank/omitted one means "keep what's stored".
        index = album_data.get("index") or (existing.index if existing else None)
        password = album_data.get("invokeai_password") or (
            existing.invokeai_password if existing else None
        )
        album = create_album(
            key=album_data["key"],
            name=album_data["name"],
            image_paths=album_data.get("image_paths"),
            index=index,
            umap_eps=album_data.get("umap_eps", 0.07),
            description=album_data.get("description", ""),
            encoder_spec=album_data.get("encoder_spec"),
            min_search_score=album_data.get("min_search_score"),
            max_search_results=album_data.get("max_search_results"),
            use_query_optimization=album_data.get("use_query_optimization"),
            min_image_dimension=album_data.get("min_image_dimension"),
            min_image_bytes=album_data.get("min_image_bytes"),
            source_type=album_data.get("source_type", "directory"),
            invokeai_url=album_data.get("invokeai_url"),
            invokeai_username=album_data.get("invokeai_username"),
            invokeai_password=password,
            invokeai_root=album_data.get("invokeai_root"),
            invokeai_board_ids=album_data.get("invokeai_board_ids"),
        )

        logger.info(f"Updating album: {album.key} with index {album.index}")

        if config_manager.update_album(album):
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
    album_config = config_manager.get_album(request.album)
    if not album_config:
        raise HTTPException(status_code=404, detail="Album not found")
    album_config.umap_eps = request.eps
    config_manager.update_album(album_config)
    return {"success": True, "eps": request.eps}


@album_router.post("/get_umap_eps/", tags=["Albums"])
async def get_umap_eps(request: UmapEpsGetRequest):
    check_album_lock(request.album)  # May raise a 403 exception
    album_config = config_manager.get_album(request.album)
    if not album_config:
        raise HTTPException(status_code=404, detail="Album not found")
    return {"success": True, "eps": album_config.umap_eps}


