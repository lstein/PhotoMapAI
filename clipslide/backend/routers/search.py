'''
clipslide.backend.routers.search
This module contains the search-related API endpoints for the Clipslide backend.
It allows searching images by similarity or text, retrieving image metadata,
and serving images and thumbnails.
'''

import tempfile
import shutil

from PIL import Image, ImageOps
from fastapi import (
    APIRouter,
    File,
    Form,
    HTTPException,
    UploadFile,
)
from fastapi.responses import JSONResponse, FileResponse
from pydantic import BaseModel
from pathlib import Path

from typing import List

from ..constants import DEFAULT_ALBUM, DEFAULT_TOP_K
from ..config import get_config_manager
from ..metadata_modules import SlideSummary
from .album import validate_album_exists, get_embeddings_for_album, validate_image_access

config_manager = get_config_manager()
search_router = APIRouter()

# Response Models
class SearchResult(BaseModel):
    filename: str
    score: float


class SearchResultsResponse(BaseModel):
    results: List[SearchResult]


# Search Routes
@search_router.post("/search_with_text_and_image/", response_model=SearchResultsResponse, tags=["Search"])
async def search_with_text_and_image(
    file: UploadFile = File(None),
    positive_query: str = Form(None),
    negative_query: str = Form(None),
    image_weight: float = Form(0.5),
    positive_weight: float = Form(0.5),
    negative_weight: float = Form(0.5),
    album: str = Form(DEFAULT_ALBUM),
    top_k: int = Form(DEFAULT_TOP_K),
) -> SearchResultsResponse:
    """
    Search for images using a combination of image, positive text, and negative text queries with separate weights.
    """
    temp_path = None
    try:
        # Save uploaded file temporarily if provided
        if file is not None:
            with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as tmp:
                shutil.copyfileobj(file.file, tmp)
                temp_path = Path(tmp.name)
            query_image_path = temp_path
        else:
            query_image_path = None

        embeddings = get_embeddings_for_album(album)
        results, scores = embeddings.search_images_by_text_and_image(
            query_image_path=query_image_path,
            positive_query=positive_query,
            negative_query=negative_query,
            image_weight=image_weight,
            positive_weight=positive_weight,
            negative_weight=negative_weight,
            top_k=top_k,
        )
        return create_search_results(results, scores, album)
    finally:
        # Clean up temp file
        if temp_path and temp_path.exists():
            temp_path.unlink(missing_ok=True)

# Image Retrieval Routes
@search_router.post("/retrieve_image/", response_model=SlideSummary, tags=["Search"])
async def retrieve_image(
    current_image: str = Form(None),
    offset: int = Form(0),
    album: str = Form(DEFAULT_ALBUM),
    random: bool = Form(False),
) -> SlideSummary:
    """Retrieve metadata for a specific image."""
    if current_image is not None:
        image_path = config_manager.find_image_in_album(album, current_image)
        if not image_path:
          raise HTTPException(status_code=404, detail="Image not found")
    else:
        image_path = None

    embeddings = get_embeddings_for_album(album)
    slide_metadata = embeddings.retrieve_image(image_path, 
                                               offset=offset, 
                                               random=random)
    create_slide_url(slide_metadata, album)
    return slide_metadata

@search_router.get("/thumbnails/{album}/{path:path}", tags=["Search"])
async def serve_thumbnail(album: str, path: str, size: int = 256) -> FileResponse:
    """Serve a reduced-size thumbnail for an image."""
    image_path = config_manager.find_image_in_album(album, path)
    if not image_path:
        raise HTTPException(status_code=404, detail="Image not found")

    album_config = validate_album_exists(album)
    if not validate_image_access(album_config, image_path):
        raise HTTPException(status_code=403, detail="Access denied")

    # Store thumbnails next to the embedding index for the album
    index_path = Path(album_config.index)
    thumb_dir = index_path.parent / "thumbnails"
    thumb_dir.mkdir(exist_ok=True)

    # Use a safe filename for the thumbnail
    relative_path = config_manager.get_relative_path(str(image_path), album)
    safe_rel_path = relative_path.replace("/", "_").replace("\\", "_")
    thumb_path = thumb_dir / f"{Path(safe_rel_path).stem}_{size}{Path(safe_rel_path).suffix}"

    # Generate thumbnail if not cached
    if not thumb_path.exists() or thumb_path.stat().st_mtime < image_path.stat().st_mtime:
        try:
            with Image.open(image_path) as im:
                im = ImageOps.exif_transpose(im)  # Correct orientation using EXIF
                im.thumbnail((size, size))
                im.save(thumb_path, quality=85)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Thumbnail error: {e}")

    return FileResponse(thumb_path)

# File Management Routes
@search_router.get("/images/{album}/{path:path}", tags=["Search"])
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


def create_slide_url(slide_metadata: SlideSummary, album: str) -> None:
    """Add URL to slide metadata."""
    relative_path = config_manager.get_relative_path(
        str(slide_metadata.filepath), album
    )
    slide_metadata.url = f"/images/{album}/{relative_path}"
