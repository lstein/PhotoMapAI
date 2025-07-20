# slideshow_server.py
import logging
import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    # Python 3.9+
    from importlib.resources import files
except ImportError:
    # Python 3.8 fallback
    from importlib_resources import files

from fastapi import (
    BackgroundTasks,
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
)
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from clipslide.backend.config import ConfigManager, create_album
from clipslide.backend.embeddings import Embeddings
from clipslide.backend.metadata_modules import SlideSummary
from clipslide.backend.progress import ProgressInfo, progress_tracker

# Initialize logging
logger = logging.getLogger(__name__)

# Initialize configuration manager
config_manager = ConfigManager()

# Constants
DEFAULT_ALBUM = "family"
DEFAULT_DELAY = 5
DEFAULT_MODE = "random"
DEFAULT_TOP_K = 20


# Response Models
class SearchResult(BaseModel):
    filename: str
    score: float


class SearchResultsResponse(BaseModel):
    results: List[SearchResult]


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


class StandardResponse(BaseModel):
    success: bool
    message: str
    album_key: Optional[str] = None


# Utility Functions
def get_package_resource_path(resource_name: str) -> str:
    """Get the path to a package resource (static files or templates)."""
    try:
        package_files = files("clipslide.frontend")
        resource_path = package_files / resource_name

        if hasattr(resource_path, "as_posix"):
            return str(resource_path)
        else:
            with resource_path as path:
                return str(path)
    except Exception:
        return str(Path(__file__).parent / resource_name)


def validate_album_exists(album_key: str):
    """Validate that an album exists, raise HTTPException if not."""
    album_config = config_manager.get_album(album_key)
    if not album_config:
        raise HTTPException(status_code=404, detail=f"Album '{album_key}' not found")
    return album_config


def validate_image_access(album_config, image_path: Path) -> bool:
    """Validate that an image path is within allowed album directories."""
    try:
        resolved_path = image_path.resolve()
        for allowed_path in album_config.image_paths:
            album_root = Path(allowed_path).resolve()
            if str(resolved_path).startswith(str(album_root)):
                return True
        return False
    except Exception:
        return False


def create_search_results(
    results: List[str], scores: List[float], album: str
) -> SearchResultsResponse:
    """Create a standardized search results response."""
    return SearchResultsResponse(
        results=[
            SearchResult(
                filename=config_manager.get_relative_path(filename, album)
                or Path(filename).name,
                score=float(score),
            )
            for filename, score in zip(results, scores)
        ]
    )


def get_embeddings_for_album(album_key: str) -> Embeddings:
    """Get embeddings instance for a given album."""
    album_config = validate_album_exists(album_key)
    return Embeddings(embeddings_path=Path(album_config.index))


def create_slide_url(slide_metadata: SlideSummary, album: str) -> None:
    """Add URL to slide metadata."""
    relative_path = config_manager.get_relative_path(
        str(slide_metadata.filepath), album
    )
    slide_metadata.url = f"/images/{album}/{relative_path}"


# Initialize FastAPI app
app = FastAPI(title="Slideshow")

# Mount static files and templates
static_path = get_package_resource_path("static")
app.mount("/static", StaticFiles(directory=static_path), name="static")

templates_path = get_package_resource_path("templates")
templates = Jinja2Templates(directory=templates_path)


# Main Routes
@app.get("/", response_class=HTMLResponse)
async def get_root(
    request: Request,
    album: str = DEFAULT_ALBUM,
    delay: int = DEFAULT_DELAY,
    mode: str = DEFAULT_MODE,
):
    """Serve the main slideshow page."""
    albums = config_manager.get_albums()

    if not albums:
        return templates.TemplateResponse(
            "slideshow.html",
            {
                "request": request,
                "album": None,
                "delay": delay,
                "mode": mode,
                "setup_mode": True,
            },
        )

    # Validate album or use first available
    if album not in albums:
        album = list(albums.keys())[0]

    return templates.TemplateResponse(
        "slideshow.html",
        {
            "request": request,
            "album": album,
            "delay": delay,
            "mode": mode,
            "setup_mode": False,
        },
    )


# Album Management Routes
@app.get("/available_albums/")
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
                "embeddings_file": album.index,
                "image_paths": album.image_paths,
            }
            for key, album in albums.items()
        ]
    except Exception as e:
        logger.error(f"Failed to get albums: {e}")
        return []


@app.post("/add_album/")
async def add_album(album_data: dict) -> JSONResponse:
    """Add a new album to the configuration."""
    try:
        album = create_album(
            key=album_data["key"],
            name=album_data["name"],
            image_paths=album_data["image_paths"],
            index=album_data["index"],
            description=album_data.get("description", ""),
        )

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
        raise HTTPException(status_code=500, detail=f"Failed to add album: {str(e)}")


@app.post("/update_album/")
async def update_album(album_data: dict) -> JSONResponse:
    """Update an existing album in the configuration."""
    try:
        album = create_album(
            key=album_data["key"],
            name=album_data["name"],
            image_paths=album_data["image_paths"],
            index=album_data["index"],
            description=album_data.get("description", ""),
        )

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


@app.delete("/delete_album/{album_key}")
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
        raise HTTPException(status_code=500, detail=f"Failed to delete album: {str(e)}")


# The LocationIQ API key for showing GPS locations
@app.get("/locationiq_key/")
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


@app.post("/locationiq_key/")
async def set_locationiq_key(request: dict):
    """Set the LocationIQ API key."""
    api_key = request.get("api_key")
    try:
        config_manager.set_locationiq_api_key(api_key)
        # Force reload to ensure other parts of app see the change
        config_manager.reload_config()
        return {"success": True, "message": "API key updated successfully"}
    except Exception as e:
        return {"success": False, "message": str(e)}


# Search Routes
@app.post("/search_with_image/", response_model=SearchResultsResponse)
async def search_with_image(
    file: UploadFile = File(...),
    album: str = Form(DEFAULT_ALBUM),
    top_k: int = Form(DEFAULT_TOP_K),
) -> SearchResultsResponse:
    """Search for similar images using a query image."""
    temp_path = None
    try:
        # Save uploaded file temporarily
        with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as tmp:
            shutil.copyfileobj(file.file, tmp)
            temp_path = Path(tmp.name)

        # Perform search
        embeddings = get_embeddings_for_album(album)
        results, scores = embeddings.search_images_by_similarity(temp_path, top_k=top_k)

        return create_search_results(results, scores, album)

    finally:
        # Clean up temp file
        if temp_path and temp_path.exists():
            temp_path.unlink(missing_ok=True)


@app.post("/search_with_text/", response_model=SearchResultsResponse)
async def search_with_text(
    text_query: str = Form(...),
    album: str = Form(DEFAULT_ALBUM),
    top_k: int = Form(DEFAULT_TOP_K),
) -> SearchResultsResponse:
    """Search for images semantically matching the query."""
    embeddings = get_embeddings_for_album(album)
    results, scores = embeddings.search_images_by_text(text_query, top_k=top_k)
    return create_search_results(results, scores, album)


# Image Retrieval Routes
@app.post("/retrieve_image/", response_model=SlideSummary)
async def retrieve_image(
    current_image: str = Form(...),
    album: str = Form(DEFAULT_ALBUM),
) -> SlideSummary:
    """Retrieve metadata for a specific image."""
    image_path = config_manager.find_image_in_album(album, current_image)
    if not image_path:
        raise HTTPException(status_code=404, detail="Image not found")

    embeddings = get_embeddings_for_album(album)
    slide_metadata = embeddings.retrieve_image(image_path)
    create_slide_url(slide_metadata, album)
    return slide_metadata


@app.post("/retrieve_next_image/", response_model=SlideSummary)
async def retrieve_next_image(
    current_image: str = Form(None),
    album: str = Form(DEFAULT_ALBUM),
    random: bool = Form(False),
) -> SlideSummary:
    """Retrieve the next image in sequence."""
    embeddings = get_embeddings_for_album(album)

    if random:
        slide_metadata = embeddings.retrieve_next_image(random=True)
    else:
        current_path = None
        if current_image:
            current_path = config_manager.find_image_in_album(album, current_image)
        slide_metadata = embeddings.retrieve_next_image(
            current_image=current_path, random=False
        )

    create_slide_url(slide_metadata, album)
    return slide_metadata


# File Management Routes
@app.get("/images/{album}/{path:path}")
async def serve_image(album: str, path: str) -> FileResponse:
    """Serve images from different albums dynamically."""
    image_path = config_manager.find_image_in_album(album, path)
    if not image_path:
        raise HTTPException(status_code=404, detail="Image not found")

    album_config = validate_album_exists(album)

    if not validate_image_access(album_config, image_path):
        raise HTTPException(status_code=403, detail="Access denied")

    if not image_path.exists() or not image_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    return FileResponse(image_path)


@app.delete("/delete_image/")
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


# Index Management Routes
@app.post("/update_index_async/", response_model=dict)
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


@app.get("/index_progress/{album_key}", response_model=ProgressResponse)
async def get_index_progress(album_key: str) -> ProgressResponse:
    """Get the current progress of an index update operation."""
    try:
        progress = progress_tracker.get_progress(album_key)
        if not progress:
            validate_album_exists(album_key)  # Ensure album exists

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

        return ProgressResponse(
            album_key=progress.album_key,
            status=progress.status.value,
            current_step=progress.current_step,
            images_processed=progress.images_processed,
            total_images=progress.total_images,
            progress_percentage=progress.progress_percentage,
            elapsed_time=progress.elapsed_time,
            estimated_time_remaining=progress.estimated_time_remaining,
            error_message=progress.error_message,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get progress: {str(e)}")


@app.delete("/cancel_index/{album_key}")
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


# Main Entry Point
def main():
    """Main entry point for the slideshow server."""
    import uvicorn

    uvicorn.run(
        "clipslide.frontend.slideshow_server:app",
        host="0.0.0.0",
        port=8050,
        reload=True,
        reload_dirs=["./clipslide", "./clipslide/frontend", "./clipslide/backend"],
    )


if __name__ == "__main__":
    main()
