import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import List

try:
    # Python 3.9+
    from importlib.resources import files
except ImportError:
    # Python 3.8 fallback
    from importlib_resources import files

from fastapi import FastAPI, File, Form, Request, UploadFile, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from clipslide.backend.embeddings import Embeddings
from clipslide.backend.metadata_modules import SlideSummary

# Read from environment variables or use defaults
IMAGES_ROOT = os.environ.get("IMAGES_ROOT", "/net/cubox/CineRAID")

# Temporary dictionary to map photo album names to their paths under IMAGES_ROOT
PHOTO_ALBUMS = {
    "family": os.path.join(IMAGES_ROOT, "Pictures"),
    "smut": os.path.join(IMAGES_ROOT, "Archive/Pictures"),
    "invoke": os.path.join(IMAGES_ROOT, "Archive/InvokeAI"),
    "yiffy": os.path.join(IMAGES_ROOT, "Archive/InvokeAI/Yiffy"),
    "legacy": os.path.join(IMAGES_ROOT, "Archive/InvokeAI/2023/1"),
    "gps_test": os.path.join(IMAGES_ROOT, "Pictures/2020"),
}

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
app.mount("/images", StaticFiles(directory=IMAGES_ROOT), name="images")

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


@app.get("/", response_class=HTMLResponse)
async def get_root(
    request: Request,
    album: str = "family",  # Default to 'family' if not provided
    delay: int = 5,  # Default delay
    mode: str = "random",  # Default mode
):
    # Validate the album parameter
    if album not in PHOTO_ALBUMS:
        album = "family"  # Fallback to default if invalid

    print(f"Serving slideshow for album: {album}, delay: {delay}, mode: {mode}")

    return templates.TemplateResponse(
        "slideshow.html",
        {
            "request": request,
            "album": album,
            "delay": delay,
            "mode": mode,
            # the embeddings file is always at the root of the album
            "embeddings_file": Path(PHOTO_ALBUMS[album], "embeddings.npz").as_posix(),
        },
    )


@app.post("/search_with_image/", response_model=SearchResultsResponse)
async def do_embedding_search_by_image(
    file: UploadFile = File(...),
    embeddings_file: str = Form("clip_image_embeddings.npz"),
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
                filename=Path(filename).relative_to(IMAGES_ROOT).as_posix(),
                score=float(score),
            )
            for filename, score in zip(results, scores)
        ]
    )


@app.post("/search_with_text/", response_model=SearchResultsResponse)
async def do_embedding_search_by_text(
    text_query: str = Form(...),
    embeddings_file: str = Form("clip_image_embeddings.npz"),
    top_k: int = Form(20),
) -> SearchResultsResponse:
    """Search for images semantically matching the query."""
    # Call the search_images function
    embeddings = Embeddings(embeddings_path=Path(embeddings_file))
    results, scores = embeddings.search_images_by_text(text_query, top_k=top_k)

    return SearchResultsResponse(
        results=[
            SearchResult(
                filename=Path(filename).as_posix(),
                score=float(score),
            )
            for filename, score in zip(results, scores)
        ]
    )


@app.post("/retrieve_image/", response_model=SlideSummary)
async def retrieve_image(
    current_image: str = Form(...),
    embeddings_file: str = Form("clip_image_embeddings.npz"),
) -> SlideSummary:
    """Retrieve the next image based on the current image."""
    # Load embeddings
    embeddings = Embeddings(embeddings_path=Path(embeddings_file))
    slide_metadata = embeddings.retrieve_image(Path(IMAGES_ROOT, current_image))
    slide_metadata.url = (Path('/images') / Path(slide_metadata.filepath).relative_to(IMAGES_ROOT)).as_posix()
    return slide_metadata


@app.post("/retrieve_next_image/", response_model=SlideSummary)
async def retrieve_next_image(
    current_image: str = Form(None),
    embeddings_file: str = Form("clip_image_embeddings.npz"),
    random: bool = Form(False),
) -> SlideSummary:
    """Retrieve the next image based on the current image."""
    # Load embeddings
    embeddings = Embeddings(embeddings_path=Path(embeddings_file))

    if random:
        # Return a random image from the embeddings
        slide_metadata = embeddings.retrieve_next_image(random=True)
    else:
        # Get the next image based on the current image
        slide_metadata = embeddings.retrieve_next_image(
            current_image=Path(current_image) if current_image else None, 
            random=False
        )
    slide_metadata.url = (Path('/images') / Path(slide_metadata.filepath).relative_to(IMAGES_ROOT)).as_posix()
    return slide_metadata

@app.delete("/delete_image/")
async def delete_image(file_to_delete: str, embeddings_file: str) -> JSONResponse:
    """Delete an image file."""
    try:

        image_path = Path(file_to_delete)
        
        # Security check: ensure the file is within IMAGES_ROOT
        resolved_path = image_path.resolve()
        images_root_resolved = Path(IMAGES_ROOT).resolve()
        
        if not str(resolved_path).startswith(str(images_root_resolved)):
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

        # And removing it from the embeddings file
        embeddings = Embeddings(embeddings_path=Path(embeddings_file))
        embeddings.remove_image_from_embeddings(image_path)

        return JSONResponse(
            content={"success": True, "message": f"Deleted {file_to_delete}"},
            status_code=200
        )
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete file: {str(e)}")

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
