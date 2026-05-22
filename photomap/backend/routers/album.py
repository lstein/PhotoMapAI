import logging
import os
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ..config import Album, create_album, get_config_manager
from ..embeddings import Embeddings


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
            {
                "key": key,
                "name": album.name,
                "description": album.description,
                "index": album.index,
                "umap_eps": album.umap_eps,
                "image_paths": album.image_paths,
                "encoder_spec": album.encoder_spec,
                "min_search_score": album.min_search_score,
                "max_search_results": album.max_search_results,
                "use_query_optimization": album.use_query_optimization,
            }
            for key, album in albums.items()
            if locked_albums is None or key in locked_albums
        ]
    except Exception as e:
        logger.error(f"Failed to get albums: {e}")
        return []


@album_router.get("/album/{album_key}/", tags=["Albums"])
async def get_album(album: AlbumDep) -> Album:
    """Get details of a specific album."""
    return album


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
        album = create_album(
            key=album_data["key"],
            name=album_data["name"],
            image_paths=album_data["image_paths"],
            index=album_data["index"],
            umap_eps=album_data.get("umap_eps", 0.07),
            description=album_data.get("description", ""),
            encoder_spec=album_data.get("encoder_spec"),
            min_search_score=album_data.get("min_search_score"),
            max_search_results=album_data.get("max_search_results"),
            use_query_optimization=album_data.get("use_query_optimization"),
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
        if config_manager.delete_album(album_key):
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


