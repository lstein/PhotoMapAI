"""
photomap.backend.routers.index
This module contains the index-related API endpoints for the Clipslide backend.
It allows creating, deleting, and checking the existence of embeddings indices for albums.
"""

import logging
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps
from pydantic import BaseModel

from ..config import get_config_manager
from ..constants import DEFAULT_ALBUM
from ..embeddings import Embeddings
from ..progress import progress_tracker
from .album import check_album_lock, validate_album_exists, validate_image_access

index_router = APIRouter()

logger = logging.getLogger(__name__)
config_manager = get_config_manager()


class ProgressResponse(BaseModel):
    album_key: str
    status: str
    current_step: str
    images_processed: int
    total_images: int
    progress_percentage: float
    elapsed_time: float
    estimated_time_remaining: Optional[float]
    error_message: Optional[str] = None


class UpdateIndexRequest(BaseModel):
    album_key: str


class EmbeddingsIndexMetadata(BaseModel):
    filename_count: int
    embeddings_path: str
    last_modified: float


# Note: How check_album_lock is used in this file:
# For any state-changing operations, such as starting an index update or deleting an index,
# if the environment variable PHOTOMAP_ALBUM_LOCKED is set, the operation is forbidden.
# For read-only operations, such as checking if an index exists or getting index metadata,
# the album_key is checked against the value of PHOTOMAP_ALBUM_LOCKED, and if they don't match, the operation is forbidden.


# Index Management Routes
@index_router.post(
    "/update_index_async/", response_model=dict, status_code=202, tags=["Index"]
)
async def update_index_async(
    background_tasks: BackgroundTasks,
    req: UpdateIndexRequest,
) -> dict:
    """Start an asynchronous index update for the specified album."""
    check_album_lock()  # May raise a 403 exception
    album_key = req.album_key
    try:
        if progress_tracker.is_running(album_key):
            raise HTTPException(
                status_code=409,
                detail=f"Index update already running for album '{album_key}'",
            )

        album_config = validate_album_exists(album_key)
        background_tasks.add_task(
            _update_index_background_async, album_key, album_config
        )

        return {
            "success": True,
            "message": f"Index update for album '{album_key}' started in background",
            "album_key": album_key,
            "task_id": album_key,  # This is the convention.
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to start background index update: {str(e)}"
        )


@index_router.delete("/remove_index/{album_key}", tags=["Index"])
async def remove_index(album_key: str) -> JSONResponse:
    """Remove the embeddings index for the specified album."""
    check_album_lock()  # May raise a 403 exception
    try:
        album_config = config_manager.get_album(album_key)
        if not album_config:
            raise HTTPException(
                status_code=404, detail=f"Album '{album_key}' not found"
            )

        index_path = Path(album_config.index)
        if not index_path.exists():
            raise HTTPException(status_code=404, detail="Index file does not exist")

        # Remove the index file
        index_path.unlink()
        logger.info(f"Removed index file: {index_path}")

        return JSONResponse(
            content={
                "success": True,
                "message": f"Removed index for album '{album_key}'",
            },
            status_code=200,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to remove index: {str(e)}")


@index_router.get(
    "/index_progress/{album_key}", response_model=ProgressResponse, tags=["Index"]
)
async def get_index_progress(album_key: str) -> ProgressResponse:
    """Get the current progress of an index update operation."""
    check_album_lock(album_key)  # May raise a 403 exception
    try:
        progress = progress_tracker.get_progress(album_key)
        if not progress:
            validate_album_exists(album_key)
            return ProgressResponse(
                album_key=album_key,
                status="idle",
                current_step="No operation in progress",
                images_processed=0,
                total_images=0,
                progress_percentage=0.0,
                elapsed_time=0.0,
                estimated_time_remaining=None,
            )

        # Ensure numbers are always valid
        images_processed = progress.images_processed or 0
        total_images = progress.total_images or 1  # Avoid division by zero

        return ProgressResponse(
            album_key=progress.album_key,
            status=progress.status.value,
            current_step=progress.current_step,
            images_processed=images_processed,
            total_images=total_images,
            progress_percentage=(
                progress.progress_percentage
                if hasattr(progress, "progress_percentage")
                else 0.0
            ),
            elapsed_time=progress.elapsed_time,
            estimated_time_remaining=progress.estimated_time_remaining,
            error_message=progress.error_message,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get progress: {str(e)}")


@index_router.delete("/cancel_index/{album_key}", tags=["Index"])
async def cancel_index_operation(album_key: str) -> dict:
    """Cancel an ongoing index operation."""
    check_album_lock(album_key)  # May raise a 403 exception
    try:
        if not progress_tracker.is_running(album_key):
            raise HTTPException(
                status_code=404, detail=f"No active operation for album '{album_key}'"
            )

        progress_tracker.set_error(album_key, "Operation cancelled by user")

        return {
            "success": True,
            "message": f"Index operation for album '{album_key}' cancelled",
            "album_key": album_key,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to cancel operation: {str(e)}"
        )


# Return true if the index exists for the specified album
@index_router.get("/index_exists/{album_key}", tags=["Index"])
async def index_exists(album_key: str) -> dict:
    """Check if the index exists for the specified album."""
    check_album_lock(album_key)  # May raise a 403 exception
    album_config = config_manager.get_album(album_key)
    if not album_config:
        raise HTTPException(status_code=404, detail=f"Album '{album_key}' not found")
    index_path = Path(album_config.index)
    return {"exists": index_path.exists()}


# Return Embeddings index metadata for the specified album
@index_router.get(
    "/index_metadata/{album_key}",
    response_model=EmbeddingsIndexMetadata,
    tags=["Albums"],
)
async def index_metadata(album_key: str) -> EmbeddingsIndexMetadata:
    """Get metadata about the embeddings index for the specified album."""
    check_album_lock(album_key)  # May raise a 403 exception
    album_config = config_manager.get_album(album_key)
    if not album_config:
        raise HTTPException(status_code=404, detail=f"Album '{album_key}' not found")

    index_path = Path(album_config.index)
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="Index file does not exist")

    # Get file metadata
    last_modified = index_path.stat().st_mtime
    filename_count = len(Embeddings.open_cached_embeddings(index_path)["filenames"])

    return EmbeddingsIndexMetadata(
        filename_count=filename_count,
        embeddings_path=str(index_path),
        last_modified=last_modified,
    )


@index_router.delete("/delete_image/{album_key}/{index}", tags=["Index"])
async def delete_image(album_key: str, index: int) -> JSONResponse:
    """Delete an image file."""
    check_album_lock()  # May raise a 403 exception
    try:
        album_config = validate_album_exists(album_key)
        embeddings = Embeddings(embeddings_path=Path(album_config.index))
        image_path = embeddings.get_image_path(index)

        if not validate_image_access(album_config, image_path):
            raise HTTPException(status_code=403, detail="Access denied")

        if not image_path.exists() or not image_path.is_file():
            raise HTTPException(status_code=404, detail="File not found")

        print(f"Deleting image: {image_path}")
        # Delete the file
        image_path.unlink()

        # Remove from embeddings
        embeddings.remove_image_from_embeddings(index)

        return JSONResponse(
            content={"success": True, "message": f"Deleted {image_path}"},
            status_code=200,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete file: {str(e)}")


# Background Tasks
async def _update_index_background_async(album_key: str, album_config):
    """Background task for updating index with async support."""
    try:
        image_paths = [Path(path) for path in album_config.image_paths]
        index_path = Path(album_config.index)

        embeddings = Embeddings(embeddings_path=index_path)

        if index_path.exists():
            logger.info(f"Updating existing index for album '{album_key}'...")
            await embeddings.update_index_async(image_paths, album_key)
        else:
            logger.info(f"Creating new index for album '{album_key}'...")
            await embeddings.create_index_async(
                image_paths, album_key, create_index=True
            )

        logger.info(f"Index update completed for album '{album_key}'")

    except Exception as e:
        logger.error(f"Background index update failed for album '{album_key}': {e}")
        progress_tracker.set_error(album_key, str(e))
