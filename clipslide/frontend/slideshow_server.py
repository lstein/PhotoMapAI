import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import List, Optional

try:
    # Python 3.9+
    from importlib.resources import files
except ImportError:
    # Python 3.8 fallback
    from importlib_resources import files

from fastapi import FastAPI, File, Form, Request, UploadFile, HTTPException, BackgroundTasks
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from clipslide.backend.embeddings import Embeddings
from clipslide.backend.metadata_modules import SlideSummary
from clipslide.backend.config import ConfigManager
from clipslide.backend.progress import progress_tracker, ProgressInfo

# Initialize configuration manager
config_manager = ConfigManager()

def get_package_resource_path(resource_name: str) -> str:
    """Get the path to a package resource (static files or templates)."""
    try:
        # Get the package directory
        package_files = files("clipslide.frontend")
        resource_path = package_files / resource_name
        
        # For Python 3.9+, we can use as_posix() directly
        if hasattr(resource_path, 'as_posix'):
            return str(resource_path)
        else:
            # For older versions, we need to extract to a temporary location
            with resource_path as path:
                return str(path)
    except Exception:
        # Fallback for development mode - look relative to this file
        return str(Path(__file__).parent / resource_name)

app = FastAPI(title="Slideshow")

# Mount static files from package resources
static_path = get_package_resource_path("static")
app.mount("/static", StaticFiles(directory=static_path), name="static")

# Set up templates from package resources
templates_path = get_package_resource_path("templates")
templates = Jinja2Templates(directory=templates_path)

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

@app.get("/", response_class=HTMLResponse)
async def get_root(
    request: Request,
    album: str = "family",  # Default to 'family' if not provided
    delay: int = 5,  # Default delay
    mode: str = "random",  # Default mode
):
    # Validate the album parameter
    album_config = config_manager.get_album(album)
    if not album_config:
        # Try to get first available album
        albums = config_manager.get_albums()
        if albums:
            album = list(albums.keys())[0]
            album_config = albums[album]
        else:
            raise HTTPException(status_code=404, detail="No albums configured")

    return templates.TemplateResponse(
        "slideshow.html",
        {
            "request": request,
            "album": album,
            "delay": delay,
            "mode": mode,
            "embeddings_file": album_config.index,
        },
    )

@app.post("/search_with_image/", response_model=SearchResultsResponse)
async def do_embedding_search_by_image(
    file: UploadFile = File(...),
    embeddings_file: str = Form("clip_image_embeddings.npz"),
    album: str = Form("family"),
    top_k: int = Form(20),
) -> SearchResultsResponse:
    """Search for similar images using a query image."""
    # Save uploaded file to a temporary location
    with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = Path(tmp.name)

    # Call the search_images function
    embeddings = Embeddings(embeddings_path=Path(embeddings_file))
    results, scores = embeddings.search_images_by_similarity(tmp_path, top_k=top_k)

    # Clean up temp file
    tmp_path.unlink(missing_ok=True)

    return SearchResultsResponse(
        results=[
            SearchResult(
                filename=config_manager.get_relative_path(filename, album) or Path(filename).name,
                score=float(score),
            )
            for filename, score in zip(results, scores)
        ]
    )

@app.post("/search_with_text/", response_model=SearchResultsResponse)
async def do_embedding_search_by_text(
    text_query: str = Form(...),
    embeddings_file: str = Form("clip_image_embeddings.npz"),
    album: str = Form("family"),
    top_k: int = Form(20),
) -> SearchResultsResponse:
    """Search for images semantically matching the query."""
    # Call the search_images function
    embeddings = Embeddings(embeddings_path=Path(embeddings_file))
    results, scores = embeddings.search_images_by_text(text_query, top_k=top_k)

    return SearchResultsResponse(
        results=[
            SearchResult(
                filename=config_manager.get_relative_path(filename, album) or Path(filename).name,
                score=float(score),
            )
            for filename, score in zip(results, scores)
        ]
    )

@app.post("/retrieve_image/", response_model=SlideSummary)
async def retrieve_image(
    current_image: str = Form(...),
    embeddings_file: str = Form("clip_image_embeddings.npz"),
    album: str = Form("family"),
) -> SlideSummary:
    """Retrieve the next image based on the current image."""
    # Load embeddings
    embeddings = Embeddings(embeddings_path=Path(embeddings_file))
    
    # Find the image in any of the album's paths
    image_path = config_manager.find_image_in_album(album, current_image)
    if not image_path:
        raise HTTPException(status_code=404, detail="Image not found")
    
    slide_metadata = embeddings.retrieve_image(image_path)
    
    # Create album-specific URL
    relative_path = config_manager.get_relative_path(str(slide_metadata.filepath), album)
    slide_metadata.url = f"/images/{album}/{relative_path}"
    return slide_metadata

@app.post("/retrieve_next_image/", response_model=SlideSummary)
async def retrieve_next_image(
    current_image: str = Form(None),
    embeddings_file: str = Form("clip_image_embeddings.npz"),
    album: str = Form("family"),
    random: bool = Form(False),
) -> SlideSummary:
    """Retrieve the next image based on the current image."""
    # Load embeddings
    embeddings = Embeddings(embeddings_path=Path(embeddings_file))

    if random:
        slide_metadata = embeddings.retrieve_next_image(random=True)
    else:
        current_path = None
        if current_image:
            current_path = config_manager.find_image_in_album(album, current_image)
        slide_metadata = embeddings.retrieve_next_image(
            current_image=current_path, 
            random=False
        )
    
    # Create album-specific URL
    relative_path = config_manager.get_relative_path(str(slide_metadata.filepath), album)
    slide_metadata.url = f"/images/{album}/{relative_path}"
    return slide_metadata

@app.delete("/delete_image/")
async def delete_image(
    file_to_delete: str, 
    embeddings_file: str,
    album: str = Form("family")
) -> JSONResponse:
    """Delete an image file."""
    try:
        # Find the image in any of the album's paths
        image_path = config_manager.find_image_in_album(album, file_to_delete)
        if not image_path:
            raise HTTPException(status_code=404, detail="File not found")
        
        # Security check: ensure the file is within one of the album's directories
        album_config = config_manager.get_album(album)
        if not album_config:
            raise HTTPException(status_code=404, detail="Album not found")
        
        resolved_path = image_path.resolve()
        allowed = False
        for allowed_path in album_config.image_paths:
            album_root = Path(allowed_path).resolve()
            if str(resolved_path).startswith(str(album_root)):
                allowed = True
                break
        
        if not allowed:
            raise HTTPException(status_code=403, detail="Access denied")
        
        if not image_path.exists():
            raise HTTPException(status_code=404, detail="File not found")
        
        if not image_path.is_file():
            raise HTTPException(status_code=400, detail="Path is not a file")
        
        # Delete the file
        try:
            image_path.unlink()
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"Failed to delete file: {str(e)}")

        # Remove from embeddings
        embeddings = Embeddings(embeddings_path=Path(embeddings_file))
        embeddings.remove_image_from_embeddings(image_path)

        return JSONResponse(
            content={"success": True, "message": f"Deleted {file_to_delete}"},
            status_code=200
        )
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete file: {str(e)}")

@app.get("/images/{album}/{path:path}")
async def serve_image(album: str, path: str):
    """Serve images from different albums dynamically."""
    # Find the image in any of the album's paths
    image_path = config_manager.find_image_in_album(album, path)
    if not image_path:
        raise HTTPException(status_code=404, detail="Image not found")
    
    # Security check - ensure path is within one of the album directories
    album_config = config_manager.get_album(album)
    if not album_config:
        raise HTTPException(status_code=404, detail="Album not found")
    
    try:
        resolved_path = image_path.resolve()
        allowed = False
        for allowed_path in album_config.image_paths:
            album_root = Path(allowed_path).resolve()
            if str(resolved_path).startswith(str(album_root)):
                allowed = True
                break
        
        if not allowed:
            raise HTTPException(status_code=403, detail="Access denied")
    except Exception:
        raise HTTPException(status_code=403, detail="Invalid path")
    
    # Check if file exists
    if not image_path.exists() or not image_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    
    # Serve the file
    from fastapi.responses import FileResponse
    return FileResponse(image_path)

@app.get("/available_albums/")
async def get_available_albums():
    """Return list of available albums with embeddings paths and metadata."""
    albums = config_manager.get_albums()
    return [
        {
            "key": album.key,
            "name": album.name,
            "description": album.description,
            "image_paths": album.image_paths,
            "embeddings_file": album.index
        }
        for album in albums.values()
    ]

@app.post("/update_index_async/", response_model=dict)
async def update_index_async(
    background_tasks: BackgroundTasks,
    album_key: str = Form(...),
) -> dict:
    """Start an asynchronous index update for the specified album."""
    try:
        # Check if already running
        if progress_tracker.is_running(album_key):
            raise HTTPException(
                status_code=409,
                detail=f"Index update already running for album '{album_key}'"
            )
        
        # Get album configuration
        album_config = config_manager.get_album(album_key)
        if not album_config:
            raise HTTPException(
                status_code=404, 
                detail=f"Album '{album_key}' not found"
            )
        
        # Add the update task to background tasks
        background_tasks.add_task(
            _update_index_background_async,
            album_key,
            album_config
        )
        
        return {
            "success": True,
            "message": f"Index update for album '{album_key}' started in background",
            "album_key": album_key
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to start background index update: {str(e)}"
        )

async def _update_index_background_async(album_key: str, album_config):
    """Background task for updating index with async support."""
    try:
        # Convert string paths to Path objects
        image_paths = [Path(path) for path in album_config.image_paths]
        index_path = Path(album_config.index)
        
        # Validate that at least one image path exists
        existing_paths = [path for path in image_paths if path.exists()]
        if not existing_paths:
            progress_tracker.set_error(
                album_key, 
                f"None of the image paths exist: {album_config.image_paths}"
            )
            return
        
        # Create embeddings instance
        embeddings = Embeddings(embeddings_path=index_path)
        
        # Check if index file exists to determine operation type
        if index_path.exists():
            print(f"Updating existing index for album '{album_key}'...")
            await embeddings.update_index_async(image_paths, album_key)
        else:
            print(f"Creating new index for album '{album_key}'...")
            await embeddings.create_index_async(image_paths, album_key, create_index=True)
            
        print(f"Index update completed for album '{album_key}'")
        
    except Exception as e:
        print(f"Background index update failed for album '{album_key}': {e}")
        progress_tracker.set_error(album_key, str(e))

@app.get("/index_progress/{album_key}", response_model=ProgressResponse)
async def get_index_progress(album_key: str) -> ProgressResponse:
    """Get the current progress of an index update operation."""
    try:
        progress = progress_tracker.get_progress(album_key)
        if not progress:
            # Check if album exists
            album_config = config_manager.get_album(album_key)
            if not album_config:
                raise HTTPException(
                    status_code=404,
                    detail=f"Album '{album_key}' not found"
                )
            
            # No active operation
            return ProgressResponse(
                album_key=album_key,
                status="idle",
                current_step="No operation in progress",
                images_processed=0,
                total_images=0,
                progress_percentage=0.0,
                elapsed_time=0.0,
                estimated_time_remaining=None
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
            error_message=progress.error_message
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to get progress: {str(e)}"
        )

@app.delete("/cancel_index/{album_key}")
async def cancel_index_operation(album_key: str) -> dict:
    """Cancel an ongoing index operation."""
    try:
        if not progress_tracker.is_running(album_key):
            raise HTTPException(
                status_code=404,
                detail=f"No active operation for album '{album_key}'"
            )
        
        # Note: This is a simple cancellation - you might want to implement
        # more sophisticated cancellation with asyncio.Task cancellation
        progress_tracker.set_error(album_key, "Operation cancelled by user")
        
        return {
            "success": True,
            "message": f"Index operation for album '{album_key}' cancelled",
            "album_key": album_key
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to cancel operation: {str(e)}"
        )

def main():
    """Main entry point for the slideshow server."""
    import uvicorn
    uvicorn.run("clipslide.frontend.slideshow_server:app", 
                host="0.0.0.0", 
                port=8050,
                reload=True,
                reload_dirs=["./clipslide", "./clipslide/frontend", "./clipslide/backend"],
                )

if __name__ == "__main__":
    main()
