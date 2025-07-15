"""
DEPRECATED. Do not use this file.
"""


from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import JSONResponse
from pathlib import Path
import shutil
import tempfile
import base64
from backend.embeddings import Embeddings
from pydantic import BaseModel
from typing import List

from backend.metadata_modules import SlideMetadata

app = FastAPI(title="CLIP Image Search API")

class NextImageResponse(SlideMetadata):
    pass

class SearchResult(BaseModel):
    filename: str
    score: float

class SearchResultsResponse(BaseModel):
    results: List[SearchResult]

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
            SearchResult(filename=str(filename), score=float(score))
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
            SearchResult(filename=str(filename), score=float(score))
            for filename, score in zip(results, scores)
        ]
    )

@app.post("/retrieve_next_image/", response_model=SlideMetadata)
async def retrieve_next_image(
    current_image: str = Form(...),
    embeddings_file: str = Form("clip_image_embeddings.npz"),
    random: bool = Form(False),
) -> SlideMetadata:
    """Retrieve the next image based on the current image."""
    # Load embeddings
    embeddings = Embeddings(embeddings_path=Path(embeddings_file))
    
    # Get the next image based on the current image
    if random:
        # If random is True, return a random image from the embeddings
        metadata = embeddings.retrieve_next_image(random=True)
    else:
        metadata = embeddings.retrieve_next_image(current_image=Path(current_image),
                                               random=False)

    # Return results as JSON
    return metadata

@app.post("/retrieve_image/", response_model=SlideMetadata)
async def retrieve_image(
    current_image: str = Form(...),
    embeddings_file: str = Form("clip_image_embeddings.npz"),
) -> SlideMetadata:
    """Retrieve the next image based on the current image."""
    # Load embeddings
    embeddings = Embeddings(embeddings_path=Path(embeddings_file))
    return embeddings.retrieve_image(current_image=Path(current_image)
