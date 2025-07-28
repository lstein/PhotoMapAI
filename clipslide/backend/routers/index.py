'''
clipslide.backend.routers.index
This module contains the index-related API endpoints for the Clipslide backend.
It allows creating, deleting, and checking the existence of embeddings indices for albums.
'''
import logging

from PIL import Image, ImageOps
from fastapi import (
    APIRouter,
    BackgroundTasks,
    Form,
    HTTPException,
)
from fastapi.responses import JSONResponse, FileResponse
from pydantic import BaseModel
from pathlib import Path
from typing import Optional

from .album import validate_album_exists, validate_image_access
from ..constants import DEFAULT_ALBUM
from ..config import get_config_manager
from ..embeddings import Embeddings
from ..progress import progress_tracker
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

# Index Management Routes
@index_router.post("/update_index_async/", response_model=dict, tags=["Index"])
async def update_index_async(
    background_tasks: BackgroundTasks,
    album_key: str = Form(...),
) -> dict:
    """Start an asynchronous index update for the specified album."""
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
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to start background index update: {str(e)}"
        )


@index_router.get("/index_progress/{album_key}", response_model=ProgressResponse, tags=["Index"])
async def get_index_progress(album_key: str) -> ProgressResponse:
    """Get the current progress of an index update operation."""
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
            progress_percentage=progress.progress_percentage if hasattr(progress, "progress_percentage") else 0.0,
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

@index_router.delete("/delete_image/", tags=["Index"])
async def delete_image(
    file_to_delete: str, album: str = Form(DEFAULT_ALBUM)
) -> JSONResponse:
    """Delete an image file."""
    try:
        image_path = config_manager.find_image_in_album(album, file_to_delete)
        if not image_path:
            raise HTTPException(status_code=404, detail="File not found")

        album_config = validate_album_exists(album)

        if not validate_image_access(album_config, image_path):
            raise HTTPException(status_code=403, detail="Access denied")

        if not image_path.exists() or not image_path.is_file():
            raise HTTPException(status_code=404, detail="File not found")

        # Delete the file
        image_path.unlink()

        # Remove from embeddings
        embeddings = Embeddings(embeddings_path=Path(album_config.index))
        embeddings.remove_image_from_embeddings(image_path)

        return JSONResponse(
            content={"success": True, "message": f"Deleted {file_to_delete}"},
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

        # Validate paths exist
        existing_paths = [path for path in image_paths if path.exists()]
        if not existing_paths:
            progress_tracker.set_error(
                album_key, f"None of the image paths exist: {album_config.image_paths}"
            )
            return

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
