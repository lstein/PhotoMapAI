import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
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


def check_album_lock(album_key: Optional[str] = None):
    locked_album = os.environ.get("PHOTOMAP_ALBUM_LOCKED")
    if album_key and locked_album and album_key != locked_album:
        logger.warning(
            f"Attempt to modify locked album configuration: {album_key} != {locked_album}"
        )
        raise HTTPException(
            status_code=403,
            detail=f"Album management is locked to album '{locked_album}' in this deployment.",
        )

    elif locked_album and not album_key:
        logger.warning("Attempt to modify locked album configuration")
        raise HTTPException(
            status_code=403,
            detail="Album management is locked in this deployment.",
        )


# Album Management Routes
@album_router.get("/available_albums/", tags=["Albums"])
async def get_available_albums() -> List[Dict[str, Any]]:
    """Get list of available albums."""
    try:
        albums = config_manager.get_albums()

        if not albums:
            return []

        return [
            {
                "key": key,
                "name": album.name,
                "description": album.description,
                "index": album.index,
                "umap_eps": album.umap_eps,
                "image_paths": album.image_paths,
            }
            for key, album in albums.items()
            if os.environ.get("PHOTOMAP_ALBUM_LOCKED") is None
            or key == os.environ.get("PHOTOMAP_ALBUM_LOCKED")
        ]
    except Exception as e:
        logger.error(f"Failed to get albums: {e}")
        return []


@album_router.get("/album/{album_key}/", tags=["Albums"])
async def get_album(album_key: str) -> Album:
    """Get details of a specific album."""
    check_album_lock(album_key)
    album = config_manager.get_album(album_key)
    if not album:
        raise HTTPException(status_code=404, detail=f"Album '{album_key}' not found")
    return album


# TO DO: Replace album_data dict with a proper Pydantic model
@album_router.post("/add_album/", tags=["Albums"])
async def add_album(album: Album) -> JSONResponse:
    """Add a new album to the configuration."""
    check_album_lock()  # May raise a 403 exception
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
        raise HTTPException(status_code=500, detail=f"Failed to add album: {str(e)}")


@album_router.post("/update_album/", tags=["Albums"])
async def update_album(album_data: dict) -> JSONResponse:
    """Update an existing album in the configuration."""
    check_album_lock()  # May raise a 403 exception
    try:
        album = create_album(
            key=album_data["key"],
            name=album_data["name"],
            image_paths=album_data["image_paths"],
            index=album_data["index"],
            umap_eps=album_data.get("umap_eps", 0.07),
            description=album_data.get("description", ""),
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
        raise HTTPException(status_code=500, detail=f"Failed to update album: {str(e)}")


@album_router.delete("/delete_album/{album_key}", tags=["Albums"])
async def delete_album(album_key: str) -> JSONResponse:
    """Delete an album from the configuration."""
    check_album_lock()  # May raise a 403 exception
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
        raise HTTPException(status_code=500, detail=f"Failed to delete album: {str(e)}")


# The LocationIQ API key for showing GPS locations
@album_router.get("/locationiq_key/", tags=["Albums"])
async def get_locationiq_key():
    """Get the current LocationIQ API key (masked for security)."""
    check_album_lock()  # May raise a 403 exception
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


@album_router.post("/locationiq_key/", tags=["Albums"])
async def set_locationiq_key(request: LocationIQSetRequest):
    """Set the LocationIQ API key."""
    check_album_lock()  # May raise a 403 exception
    api_key = request.key
    try:
        config_manager.set_locationiq_api_key(api_key)
        # Force reload to ensure other parts of app see the change
        config_manager.reload_config()
        return {"success": True, "message": "API key updated successfully"}
    except Exception as e:
        return {"success": False, "message": str(e)}


@album_router.post("/set_umap_eps/", tags=["Albums"])
async def set_umap_eps(request: UmapEpsSetRequest):
    check_album_lock()  # May raise a 403 exception
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


# Various utility functions - might want to move them into their own module later
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
    return Embeddings(embeddings_path=Path(album_config.index))


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
    return any(
        [
            image_path.resolve().is_relative_to(Path(p).resolve())
            for p in album_config.image_paths
        ]
    )


@album_router.get("/filetree/home", tags=["File Management"])
async def get_home_directory():
    """Get the home directory path for the current user."""
    # In a real application, you would determine the home directory based on the user's
    # profile or configuration. Here, we just return a fixed path for demonstration.
    try:
        home_dir = str(Path.home())
        return {"homePath": home_dir}
    except Exception as e:
        logger.error(f"Error getting home directory: {e}")
        return {"homePath": ""}
