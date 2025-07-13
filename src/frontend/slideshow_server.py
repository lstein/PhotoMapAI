import os
import shutil
import tempfile
from pathlib import Path
from typing import List

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from .embeddings import Embeddings

# Read from environment variables or use defaults
IMAGES_ROOT = os.environ.get("IMAGES_ROOT", "/net/cubox/CineRAID")

# Temporary dictionary to map photo album names to their paths under IMAGES_ROOT
# This will ultimately be replaced with a system that lets the user configure albums
# and their paths.
PHOTO_ALBUMS = {
    "family": os.path.join(IMAGES_ROOT,'Pictures'),
    "smut": os.path.join(IMAGES_ROOT,'Archive/Pictures'),
    "invoke": os.path.join(IMAGES_ROOT,'Archive/InvokeAI'),
}
                            
app = FastAPI(title="Slideshow")
app.mount("/images", StaticFiles(directory=IMAGES_ROOT), name="images")
app.mount("/static", StaticFiles(directory="./src/frontend/static"), name="static")

# Add templates
templates = Jinja2Templates(directory="./src/frontend/templates")

# Response models
class NextImageResponse(BaseModel):
    filename: str
    description: str
    filepath: str
    url: str
    relpath: str
    textToCopy: str

class SearchResult(BaseModel):
    filename: str
    score: float

class SearchResultsResponse(BaseModel):
    results: List[SearchResult]


@app.get("/", response_class=HTMLResponse)
async def get_root(
    request: Request, 
    type: str = "family",  # Default to 'family' if not provided
    delay: int = 5,        # Default delay
    mode: str = "random"   # Default mode
):
    # Validate the type parameter
    if type not in PHOTO_ALBUMS:
        type = "family"  # Fallback to default if invalid
    
    return templates.TemplateResponse("slideshow.html", {
        "request": request,
        "delay": delay,
        "mode": mode,
        # the embeddings file is always at the root of the album
        "embeddings_file": Path(PHOTO_ALBUMS[type],'embeddings.npz').as_posix(),
    })

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
            SearchResult(filename=Path(filename).relative_to(IMAGES_ROOT).as_posix(), score=float(score))
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
            SearchResult(filename=Path(filename).relative_to(IMAGES_ROOT).as_posix(), score=float(score))
            for filename, score in zip(results, scores)
        ]
    )

@app.post("/retrieve_next_image/", response_model=NextImageResponse)
async def retrieve_next_image(
    current_image: str = Form(...),
    embeddings_file: str = Form("clip_image_embeddings.npz"),
    random: bool = Form(False),
) -> NextImageResponse:
    """Retrieve the next image based on the current image."""
    # Load embeddings
    embeddings = Embeddings(embeddings_path=Path(embeddings_file))
    
    # Get the next image based on the current image
    if random:
        # If random is True, return a random image from the embeddings
        image, description = embeddings.retrieve_next_image(random=True)
    else:
        image, description = embeddings.retrieve_next_image(current_image=Path(IMAGES_ROOT, current_image),
                                                 random=False)

    # Return results as JSON
    image = Path(image)
    return NextImageResponse(filename=image.name,
                             description=description,
                             filepath=image.as_posix(),
                             url=image.relative_to(IMAGES_ROOT).as_posix(),
                             relpath=image.relative_to(IMAGES_ROOT).as_posix(),  #  oops, dupe
                             textToCopy=image.name)