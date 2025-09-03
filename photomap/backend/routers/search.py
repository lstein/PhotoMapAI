"""
photomap.backend.routers.search
This module contains the search-related API endpoints for the Clipslide backend.
It allows searching images by similarity or text, retrieving image metadata,
and serving images and thumbnails.
"""

import base64
import json
from io import BytesIO
from logging import getLogger
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse
from PIL import Image, ImageDraw, ImageOps
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


# Basic information about the image stored in the index
class ImageData(BaseModel):
    image_path: str
    album_key: str
    index: int
    last_modified: float


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
    "/retrieve_image/{album_key}/{index}",
    response_model=SlideSummary,
    tags=["Search"],
)
async def retrieve_image(
    album_key: str,
    index: int,
) -> SlideSummary:
    """Retrieve metadata for a specific image."""
    embeddings = get_embeddings_for_album(album_key)
    slide_metadata = embeddings.retrieve_image(index)
    create_slide_url(slide_metadata, album_key)
    return slide_metadata


# Basic information about the image stored in the index
@search_router.get(
    "/image_info/{album_key}/{index}",
    response_model=ImageData,
    tags=["Search"],
)
async def image_info(
    album_key: str,
    index: int,
) -> ImageData:
    """Retrieve basic metadata on an image."""
    embeddings = get_embeddings_for_album(album_key)
    data = embeddings.indexes
    sorted_filenames = data["sorted_filenames"]
    filename_map = data["filename_map"]
    modification_times = data["sorted_modification_times"]
    if index < 0 or index >= len(sorted_filenames):
        raise HTTPException(status_code=404, detail="Index out of range")
    filename = sorted_filenames[index]
    if filename not in filename_map:
        raise HTTPException(status_code=404, detail="Image not found in index")
    original_index = filename_map[filename]

    return ImageData(
        image_path=str(filename),
        last_modified=float(modification_times[original_index]),
        album_key=album_key,
        index=index,
    )


@search_router.get(
    "/get_metadata/{album_key}/{index}",
    tags=["Search"],
)
async def get_metadata(album_key: str, index: int):
    """
    Download the JSON-formatted metadata for an image by album key and index.
    """
    embeddings = get_embeddings_for_album(album_key)
    if not embeddings:
        raise HTTPException(status_code=404, detail="Album not found")
    indexes = embeddings.indexes
    metadata = indexes["sorted_metadata"]
    if index < 0 or index >= len(metadata):
        raise HTTPException(status_code=404, detail="Index out of range")
    metadata_json = json.dumps(metadata[index], indent=2).encode("utf-8")
    buffer = BytesIO(metadata_json)
    return StreamingResponse(buffer, media_type="application/json")


@search_router.get("/thumbnails/{album_key}/{index}", tags=["Search"])
async def serve_thumbnail(
    album_key: str,
    index: int,
    size: int = 256,
    color: Optional[str] = None,
    radius: int = 12,  # Add a radius parameter for rounded corners
) -> FileResponse:
    """Serve a reduced-size thumbnail for an image by index, with optional colored border."""
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

    index_path = Path(album_config.index)
    thumb_dir = index_path.parent / "thumbnails"
    thumb_dir.mkdir(exist_ok=True)

    relative_path = config_manager.get_relative_path(str(image_path), album_key)
    assert relative_path is not None, "Relative path should not be None"
    safe_rel_path = relative_path.replace("/", "_").replace("\\", "_")
    thumb_path = thumb_dir / f"{Path(safe_rel_path).stem}_{size}.png"

    # If color is specified, add it to the thumbnail filename to cache separately
    if color:
        color_hex = color.replace("#", "")
        thumb_path = (
            thumb_dir / f"{Path(safe_rel_path).stem}_{size}_{color_hex}_r{radius}.png"
        )

    # Generate thumbnail if not cached or outdated
    if (
        not thumb_path.exists()
        or thumb_path.stat().st_mtime < image_path.stat().st_mtime
    ):
        try:
            with Image.open(image_path) as im:
                im = ImageOps.exif_transpose(im).convert("RGBA")
                im.thumbnail((size, size))
                if color:
                    border_width = max(5, size // 32)
                    # Convert hex color to RGB
                    border_color = color
                    if color.startswith("#"):
                        border_color = tuple(
                            int(color[i : i + 2], 16) for i in (1, 3, 5)
                        )
                    else:
                        try:
                            border_color = tuple(map(int, color.split(",")))
                        except Exception:
                            border_color = (0, 0, 0)
                    # Add border
                    im = ImageOps.expand(im, border=border_width, fill=border_color)
                # Add rounded corners
                corner_radius = radius
                mask = Image.new("L", im.size, 0)
                draw = ImageDraw.Draw(mask)
                draw.rounded_rectangle(
                    [0, 0, im.size[0], im.size[1]], corner_radius, fill=255
                )
                im.putalpha(mask)
                # Save as PNG to preserve transparency
                im.save(thumb_path.with_suffix(".png"), format="PNG")
        except Exception as e:
            logger.error(f"Error generating thumbnail for {image_path}: {e}")
            raise HTTPException(status_code=500, detail=f"Thumbnail error: {e}")

    return FileResponse(thumb_path.with_suffix(".png"))


# File Management Routes
# Do NOT provide a response_model here, as it may be either an image
# or a converted stream and FastAPI refuses to work with Union types
# in response_model.
@search_router.get("/images/{album_key}/{path:path}", tags=["Search"])
async def serve_image(album_key: str, path: str):
    """Serve images from diffe rent albums dynamically."""
    image_path = config_manager.find_image_in_album(album_key, path)
    if not image_path:
        raise HTTPException(status_code=404, detail="Image not found")

    album_config = validate_album_exists(album_key)

    if not validate_image_access(album_config, image_path):
        raise HTTPException(status_code=403, detail="Access denied")

    if not image_path.exists() or not image_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    if image_path.suffix.lower() in {".heic", ".heif"}:
        return serve_image_with_conversion(image_path)
    else:
        return FileResponse(image_path)


@search_router.get(
    "/image_path/{album_key}/{index}",
    response_class=PlainTextResponse,
    tags=["Search"],
)
async def get_image_path(album_key: str, index: int) -> str:
    """
    Return the image path for a given index in the album.
    """
    embeddings = get_embeddings_for_album(album_key)
    try:
        image_path = embeddings.get_image_path(index)
        return image_path.as_posix()
    except Exception as e:
        raise HTTPException(
            status_code=404, detail=f"Image not found for index {index}: {e}"
        )


@search_router.get(
    "/image_by_name/{album_key}/{filename:path}",
    response_class=FileResponse,
    tags=["Search"],
)
async def get_image_by_name(album_key: str, filename: str) -> FileResponse:
    """
    Serve an image by its filename within the specified album.
    """
    embeddings = get_embeddings_for_album(album_key)
    if not embeddings:
        raise HTTPException(status_code=404, detail="Album not found")
    indexes = embeddings.indexes
    # inefficient linear search for the filename, but still pretty quick!
    absolute_paths = [
        x for x in indexes["sorted_filenames"] if Path(x).name == filename
    ]
    logger.info(
        f"Searching for image {filename} in album {album_key}: found {len(absolute_paths)} matches"
    )
    if not absolute_paths:
        raise HTTPException(status_code=404, detail="Image not found")
    image_path = config_manager.find_image_in_album(album_key, absolute_paths[0])
    if not image_path:
        raise HTTPException(status_code=404, detail="Image not found in album")
    album_config = validate_album_exists(album_key)
    if not validate_image_access(album_config, image_path):
        raise HTTPException(status_code=403, detail="Access denied")
    if not image_path.exists() or not image_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(image_path)


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
    logger.debug(
        f"Creating URL for slide: {slide_metadata.filepath} -> {relative_path}"
    )
    slide_metadata.metadata_url = f"get_metadata/{album_key}/{slide_metadata.index}"
    slide_metadata.image_url = f"images/{album_key}/{relative_path}"


# This is not currently used. It can be applied to the end of the image serving
# function to return a StreamingResponse with EXIF rotation applied.
# In practice, I'm seeing pauses during image serving when using this.
def serve_image_with_conversion(image_path: Path) -> StreamingResponse:
    try:
        with Image.open(image_path) as im:
            im = ImageOps.exif_transpose(im)
            buf = BytesIO()
            format = "PNG"
            im.save(buf, format=format)
            buf.seek(0)
            return StreamingResponse(buf, media_type=f"image/{format.lower()}")
    except Exception as e:
        print(f"Error processing image {image_path}: {e}")
        raise HTTPException(status_code=500, detail=f"Image processing error: {e}")
