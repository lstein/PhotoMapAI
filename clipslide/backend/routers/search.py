"""
clipslide.backend.routers.search
This module contains the search-related API endpoints for the Clipslide backend.
It allows searching images by similarity or text, retrieving image metadata,
and serving images and thumbnails.
"""

import base64
from io import BytesIO
from logging import getLogger
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
from PIL import Image, ImageOps
from pydantic import BaseModel

from ..config import get_config_manager
from ..constants import DEFAULT_TOP_K
from ..metadata_modules import SlideSummary
from .album import (
    get_embeddings_for_album,
    validate_album_exists,
    validate_image_access,
)

config_manager = get_config_manager()
search_router = APIRouter()
logger = getLogger(__name__)


# Response Models
class SearchResult(BaseModel):
    index: int
    score: float


class SearchResultsResponse(BaseModel):
    results: List[SearchResult]


# Search Routes
class SearchWithTextAndImageRequest(BaseModel):
    positive_query: str = ""
    negative_query: str = ""
    image_data: Optional[str] = None  # base64-encoded image string, or null
    image_weight: float = 0.5
    positive_weight: float = 0.5
    negative_weight: float = 0.5
    top_k: int = DEFAULT_TOP_K


@search_router.post(
    "/search_with_text_and_image/{album_key}",
    response_model=SearchResultsResponse,
    tags=["Search"],
)
async def search_with_text_and_image(
    album_key: str,
    req: SearchWithTextAndImageRequest,
) -> SearchResultsResponse:
    """
    Search for images using a combination of image (as base64), positive text, and negative text queries with separate weights.
    """
    query_image_data = None
    temp_path = None
    try:
        # If image_data is provided, decode and save to temp file
        if req.image_data:
            image_bytes = base64.b64decode(req.image_data.split(",")[-1])
            query_image_data = Image.open(BytesIO(image_bytes))

        embeddings = get_embeddings_for_album(album_key)
        results, scores = embeddings.search_images_by_text_and_image(
            query_image_data=query_image_data,
            positive_query=req.positive_query,
            negative_query=req.negative_query,
            image_weight=req.image_weight,
            positive_weight=req.positive_weight,
            negative_weight=req.negative_weight,
            top_k=req.top_k,
        )
        return create_search_results(results, scores, album_key)
    finally:
        if temp_path and temp_path.exists():
            temp_path.unlink(missing_ok=True)


# Image Retrieval Routes
@search_router.get(
    "/retrieve_image/{album_key}",
    response_model=SlideSummary,
    tags=["Search"],
)
async def retrieve_image(
    album_key: str,
    index: int = Query(..., ge=0),
) -> SlideSummary:
    """Retrieve metadata for a specific image."""
    embeddings = get_embeddings_for_album(album_key)
    slide_metadata = embeddings.retrieve_image(index)
    create_slide_url(slide_metadata, album_key)
    return slide_metadata


@search_router.get("/thumbnails/{album_key}/{index}", tags=["Search"])
async def serve_thumbnail(album_key: str, index: int, size: int = 256) -> FileResponse:
    """Serve a reduced-size thumbnail for an image by index."""
    embeddings = get_embeddings_for_album(album_key)
    try:
        image_path = embeddings.get_image_path(index)
    except Exception as e:
        raise HTTPException(
            status_code=404, detail=f"Image not found for index {index}: {e}"
        )

    album_config = validate_album_exists(album_key)
    if not validate_image_access(album_config, image_path):
        raise HTTPException(status_code=403, detail="Access denied")

    # Store thumbnails next to the embedding index for the album
    index_path = Path(album_config.index)
    thumb_dir = index_path.parent / "thumbnails"
    thumb_dir.mkdir(exist_ok=True)

    # Use a safe filename for the thumbnail
    relative_path = config_manager.get_relative_path(str(image_path), album_key)
    assert relative_path is not None, "Relative path should not be None"
    safe_rel_path = relative_path.replace("/", "_").replace("\\", "_")
    thumb_path = (
        thumb_dir / f"{Path(safe_rel_path).stem}_{size}{Path(safe_rel_path).suffix}"
    )

    # Generate thumbnail if not cached
    if (
        not thumb_path.exists()
        or thumb_path.stat().st_mtime < image_path.stat().st_mtime
    ):
        try:
            with Image.open(image_path) as im:
                im = ImageOps.exif_transpose(im)  # Correct orientation using EXIF
                im.thumbnail((size, size))
                im.save(thumb_path, quality=85)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Thumbnail error: {e}")

    return FileResponse(thumb_path)


# File Management Routes
@search_router.get("/images/{album_key}/{path:path}", tags=["Search"])
async def serve_image(album_key: str, path: str) -> FileResponse:
    """Serve images from different albums dynamically."""
    image_path = config_manager.find_image_in_album(album_key, path)
    if not image_path:
        raise HTTPException(status_code=404, detail="Image not found")

    album_config = validate_album_exists(album_key)

    if not validate_image_access(album_config, image_path):
        raise HTTPException(status_code=403, detail="Access denied")

    if not image_path.exists() or not image_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    # I'm not sure this is doing anything useful
    # return serve_image_with_exif_rotation(image_path)
    return FileResponse(image_path)


@search_router.get(
    "/image_path/{album_key}/{index}",
    response_model=str,
    tags=["Search"],
)
async def get_image_path(album_key: str, index: int) -> str:
    """
    Return the image path for a given index in the album.
    """
    embeddings = get_embeddings_for_album(album_key)
    try:
        image_path = embeddings.get_image_path(index)
        return str(image_path)
    except Exception as e:
        raise HTTPException(
            status_code=404, detail=f"Image not found for index {index}: {e}"
        )


# Utility Functions
def create_search_results(
    results: List[int], scores: List[float], album_key: str
) -> SearchResultsResponse:
    """Create a standardized search results response."""
    return SearchResultsResponse(
        results=[
            SearchResult(
                index=index,
                score=float(score),
            )
            for index, score in zip(results, scores)
        ]
    )


def create_slide_url(slide_metadata: SlideSummary, album_key: str) -> None:
    """Add URL to slide metadata."""
    relative_path = config_manager.get_relative_path(
        str(slide_metadata.filepath), album_key
    )
    slide_metadata.url = f"/images/{album_key}/{relative_path}"


# This is not currently used. It can be applied to the end of the image serving
# function to return a StreamingResponse with EXIF rotation applied.
# In practice, I'm seeing pauses during image serving when using this.
def serve_image_with_exif_rotation(image_path: Path) -> StreamingResponse:
    logger.info(f"Serving image with EXIF rotation: {image_path}")
    try:
        with Image.open(image_path) as im:
            im = ImageOps.exif_transpose(im)
            buf = BytesIO()
            format = im.format or "PNG"
            im.save(buf, format=format)
            buf.seek(0)
            return StreamingResponse(buf, media_type=f"image/{format.lower()}")
    except Exception as e:
        print(f"Error processing image {image_path}: {e}")
        raise HTTPException(status_code=500, detail=f"Image processing error: {e}")
