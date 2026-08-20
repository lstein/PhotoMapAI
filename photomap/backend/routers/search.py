"""
photomap.backend.routers.search
This module contains the search-related API endpoints for the Clipslide backend.
It allows searching images by similarity or text, retrieving image metadata,
and serving images and thumbnails.
"""

import asyncio
import base64
import functools
import hashlib
import json
import re
import zipfile
from io import BytesIO
from logging import getLogger
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse
from PIL import Image, ImageDraw, ImageOps
from pydantic import BaseModel

from ..config import get_config_manager
from ..embeddings import SUPPORTED_EXTENSIONS
from ..media_types import is_video, video_media_type
from ..metadata_modules import SlideSummary, video_external_link_html
from ..util import is_cuda_oom
from ..video_cache import VideoFrameCache
from .album import (
    AlbumDep,
    EmbeddingsDep,
    validate_image_access,
)

config_manager = get_config_manager()
search_router = APIRouter()
logger = getLogger(__name__)

# The ``color`` query param is interpolated into the on-disk thumbnail
# cache filename, so anything that survives here becomes a path segment.
# Accept only a 6-digit hex literal (with or without ``#``) or an
# ``r,g,b`` CSV of three 0-255 integers — reject everything else so a
# value like ``../../evil`` cannot escape the thumbnail cache dir.
_COLOR_RE = re.compile(r"\A#?[0-9A-Fa-f]{6}\Z|\A\d{1,3},\d{1,3},\d{1,3}\Z")
_MAX_THUMB_SIZE = 2048
_MAX_THUMB_RADIUS = 512

# ``download_images_zip`` builds its archive in memory. Videos make it easy to
# ask for far more than fits, so cap the total selection size.
_MAX_ZIP_BYTES = 2_000_000_000


def _format_bytes(size: int) -> str:
    """Human-readable size for the download-limit message.

    Falls back to MB below a gigabyte so a lowered ceiling doesn't render as
    "over the 0 GB download limit".
    """
    if size >= 1_000_000_000:
        return f"{size / 1_000_000_000:.1f} GB"
    if size >= 1_000_000:
        return f"{size / 1_000_000:.0f} MB"
    return f"{size} bytes"


# Response Models
class SearchResult(BaseModel):
    index: int
    score: float


class SearchResultsResponse(BaseModel):
    results: list[SearchResult]


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
    image_data: str | None = None  # base64-encoded image string, or null
    image_weight: float = 0.5
    positive_weight: float = 0.5
    negative_weight: float = 0.5
    min_search_score: float = 0.2
    max_search_results: int = 100
    # Optional: per-request SigLIP prompt-ensembling toggle. Frontend sources
    # this from the album's ``use_query_optimization`` setting. ``None`` keeps
    # the encoder's existing state (module default for direct callers).
    use_query_optimization: bool | None = None


class DownloadImagesZipRequest(BaseModel):
    indices: list[int]


@search_router.post(
    "/search_with_text_and_image/{album_key}",
    response_model=SearchResultsResponse,
    tags=["Search"],
)
async def search_with_text_and_image(
    album_key: str,
    req: SearchWithTextAndImageRequest,
    embeddings: EmbeddingsDep,
) -> SearchResultsResponse:
    """
    Search for images using a combination of image (as base64), positive text, and negative text queries with separate weights.
    """
    query_image_data = None
    temp_path = None
    try:
        # If image_data is provided, decode and save to temp file
        if req.image_data:
            # A query blob that isn't a still image — a video file dropped on
            # the search panel, say — used to surface as an opaque 500 from
            # deep inside PIL. The encoder only takes stills.
            try:
                image_bytes = base64.b64decode(req.image_data.split(",")[-1])
                query_image_data = Image.open(BytesIO(image_bytes))
                # ``open`` only reads the header; without an explicit load the
                # decode failure would surface later, from inside the encoder,
                # as the 500 this guard is meant to replace.
                query_image_data.load()
            except Exception as e:
                logger.info(f"Rejected an unreadable search query image: {e}")
                raise HTTPException(
                    status_code=400,
                    detail="The query image could not be read. Search by image needs a still image.",
                ) from e

        logger.info(
            f"Search request: {req.min_search_score=}, {req.max_search_results=}"
        )
        try:
            results, scores = embeddings.search_images_by_text_and_image(
                query_image_data=query_image_data,
                positive_query=req.positive_query,
                negative_query=req.negative_query,
                image_weight=req.image_weight,
                positive_weight=req.positive_weight,
                negative_weight=req.negative_weight,
                minimum_score=req.min_search_score,
                top_k=req.max_search_results,
                use_query_optimization=req.use_query_optimization,
            )
        except HTTPException:
            # Pass-through (e.g. AlbumDep / EmbeddingsDep already raised
            # a useful HTTPException; don't bury it under a generic one).
            raise
        except Exception as e:
            # Surface the failure so the frontend can show a toast instead
            # of silently rendering "no results". CUDA OOM gets its own
            # message because the user can act on it (close other GPU
            # workloads, restart the server, or fall back to CPU); other
            # exceptions surface their class name + message for diagnosis.
            logger.exception(f"Search failed for album {album_key}")
            if is_cuda_oom(e):
                raise HTTPException(
                    status_code=503,
                    detail=(
                        "GPU is out of memory. Close other GPU workloads "
                        "or restart the server to free VRAM."
                    ),
                ) from e
            raise HTTPException(
                status_code=500,
                detail=f"{type(e).__name__}: {e}",
            ) from e
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
    embeddings: EmbeddingsDep,
) -> SlideSummary:
    """Retrieve metadata for a specific image."""
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
    embeddings: EmbeddingsDep,
) -> ImageData:
    """Retrieve basic metadata on an image."""
    data = await embeddings.load_indexes()
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
async def get_metadata(album_key: str, index: int, embeddings: EmbeddingsDep):
    """
    Download the JSON-formatted metadata for an image by album key and index.
    """
    indexes = await embeddings.load_indexes()
    metadata = indexes["sorted_metadata"]
    if index < 0 or index >= len(metadata):
        raise HTTPException(status_code=404, detail="Index out of range")
    metadata_json = json.dumps(metadata[index], indent=2).encode("utf-8")
    buffer = BytesIO(metadata_json)
    return StreamingResponse(buffer, media_type="application/json")


async def _ensure_frame_off_loop(album_key: str, video_path: Path) -> Path | None:
    """Resolve a video's still without blocking the event loop.

    ``VideoFrameCache.ensure`` can spawn ffmpeg and wait up to
    ``2 x FRAME_EXTRACT_TIMEOUT_SECONDS``. These handlers are ``async def``,
    so FastAPI runs them *on the loop* rather than in its threadpool — calling
    ``ensure`` directly froze every other request in the process for the
    duration, since uvicorn is started with a single worker. Measured: an
    unrelated ``/get_albums/`` stalled behind a video extraction.

    ``asyncio.to_thread`` is the convention already used for the other
    blocking work in this codebase (``cluster_labels``, the indexer).
    """
    return await asyncio.to_thread(VideoFrameCache(album_key).ensure, video_path)


def _thumbnail_is_fresh(thumb_path: Path, source_path: Path) -> bool:
    """True if the cached thumbnail exists and is newer than its source.

    Tolerates the source disappearing between the check and the stat — a
    concurrent prune of the frame cache would otherwise raise straight out of
    the handler as a 500.
    """
    try:
        return thumb_path.exists() and thumb_path.stat().st_mtime >= source_path.stat().st_mtime
    except OSError:
        return False


# A neutral tile shown when a video's still cannot be produced, so a failed
# extraction degrades to "a video we couldn't preview" rather than a broken
# image. Cached per size: these are generated, not read from disk.
@functools.lru_cache(maxsize=8)
def _video_placeholder_png(size: int) -> bytes:
    canvas = Image.new("RGBA", (size, size), (34, 34, 34, 255))
    draw = ImageDraw.Draw(canvas)
    # A centered play triangle, sized relative to the tile.
    unit = max(4, size // 4)
    cx, cy = size // 2, size // 2
    draw.ellipse(
        [cx - unit, cy - unit, cx + unit, cy + unit],
        outline=(140, 140, 140, 255),
        width=max(1, size // 64),
    )
    draw.polygon(
        [
            (cx - unit // 3, cy - unit // 2),
            (cx - unit // 3, cy + unit // 2),
            (cx + unit // 2, cy),
        ],
        fill=(140, 140, 140, 255),
    )
    buffer = BytesIO()
    canvas.save(buffer, format="PNG")
    return buffer.getvalue()


def _video_placeholder_response(size: int) -> Response:
    return Response(
        content=_video_placeholder_png(size),
        media_type="image/png",
        # Never cached: the still may well be extractable on the next request
        # (a transient ffmpeg failure, a cache that has since been rebuilt).
        headers={"Cache-Control": "no-store"},
    )


@search_router.get("/thumbnails/{album_key}/{index}", tags=["Search"])
async def serve_thumbnail(
    album_key: str,
    index: int,
    album_config: AlbumDep,
    embeddings: EmbeddingsDep,
    size: int = 256,
    color: str | None = None,
    radius: int = 12,  # Add a radius parameter for rounded corners
) -> FileResponse:
    """Serve a reduced-size thumbnail for an image by index, with optional colored border."""
    if size <= 0 or size > _MAX_THUMB_SIZE:
        raise HTTPException(status_code=400, detail="Invalid thumbnail size")
    if radius < 0 or radius > _MAX_THUMB_RADIUS:
        raise HTTPException(status_code=400, detail="Invalid thumbnail radius")
    if color is not None and not _COLOR_RE.match(color):
        raise HTTPException(status_code=400, detail="Invalid color parameter")

    try:
        image_path = embeddings.get_image_path(index)
    except Exception as e:
        raise HTTPException(
            status_code=404, detail=f"Image not found for index {index}: {e}"
        ) from e

    if not validate_image_access(album_config, image_path):
        raise HTTPException(status_code=403, detail="Access denied")

    index_path = Path(album_config.index)
    thumb_dir = index_path.parent / "thumbnails"
    thumb_dir.mkdir(exist_ok=True)

    relative_path = config_manager.get_relative_path(str(image_path), album_key)
    if relative_path is None:
        # ``get_relative_path`` returns ``None`` only when the image falls
        # outside every configured ``image_paths`` entry — i.e. an album
        # mis-configuration, not a user-supplied bad input.
        raise HTTPException(status_code=500, detail="Image path is not inside the album")

    # Hash the full relative_path (including extension) so structurally
    # different paths can't collapse to the same cache filename. The prior
    # implementation ran ``.replace("/", "_")`` + ``Path(...).stem``, which
    # collided ``/a/b.jpg`` with ``/a_b.jpg`` (same mangled name) and
    # ``a.png`` with ``a.jpg`` (same stem) — both observable cache-poisoning
    # bugs. blake2b-128 makes collisions effectively impossible.
    rel_hash = hashlib.blake2b(relative_path.encode("utf-8"), digest_size=16).hexdigest()
    suffix = f"_{size}.png" if not color else f"_{size}_{color.lstrip('#')}_r{radius}.png"
    thumb_path = thumb_dir / f"{rel_hash}{suffix}"

    # A video has no pixels of its own to shrink, so the thumbnail is built
    # from its extracted still instead. Resolving it here rather than in each
    # caller is what lets the grid, the UMAP hover popup, the landmark
    # overlay, the back flyout and the reference-thumbnail strip all display
    # videos with no changes of their own — they are already index-based.
    #
    # Deliberately *after* the cache path is known: resolving the still is the
    # expensive half (it can spawn ffmpeg), and a warm thumbnail does not need
    # it at all. Doing it first meant every repaint of a grid of N videos paid
    # for it N times, and made a transient extraction failure 404 even when a
    # perfectly good thumbnail was already on disk.
    source_path = image_path
    if is_video(image_path):
        if _thumbnail_is_fresh(thumb_path, image_path):
            return FileResponse(thumb_path.with_suffix(".png"))
        frame_path = await _ensure_frame_off_loop(album_key, image_path)
        if frame_path is None:
            # A placeholder rather than a 404. Every caller sets img.src with
            # no error handling, so a 404 paints a broken-image glyph with no
            # diagnostic — across the grid, UMAP hover popups and landmark
            # overlays at once, and on any platform with no ffmpeg binary that
            # is *every* video.
            return _video_placeholder_response(size)
        source_path = frame_path

    # Generate thumbnail if not cached or outdated
    if not _thumbnail_is_fresh(thumb_path, source_path):
        try:
            with Image.open(source_path) as im:
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
            raise HTTPException(status_code=500, detail=f"Thumbnail error: {e}") from e

    return FileResponse(thumb_path.with_suffix(".png"))


@search_router.get("/video_frame/{album_key}/{index}", tags=["Search"])
async def serve_video_frame(
    album_key: str,
    index: int,
    album_config: AlbumDep,
    embeddings: EmbeddingsDep,
) -> Response:
    """Serve the full-size still extracted from a video, by index.

    The slideshow shows a poster at full viewport size and so wants the whole
    frame rather than a ``/thumbnails/`` reduction.  Goes through
    ``VideoFrameCache.ensure`` so a cache that was wiped or pruned regenerates
    instead of leaving a broken image on screen.
    """
    try:
        video_path = embeddings.get_image_path(index)
    except Exception as e:
        raise HTTPException(
            status_code=404, detail=f"Image not found for index {index}: {e}"
        ) from e

    if not validate_image_access(album_config, video_path):
        raise HTTPException(status_code=403, detail="Access denied")

    if not is_video(video_path):
        raise HTTPException(
            status_code=404, detail=f"Index {index} is not a video"
        )

    frame_path = await _ensure_frame_off_loop(album_key, video_path)
    if frame_path is None:
        return _video_placeholder_response(_MAX_THUMB_SIZE // 2)
    # This URL is keyed by index, and an index designates a different file
    # after a delete or a reindex reorders the album — so the poster must not
    # be cached across those. The bytes themselves are cheap to re-serve.
    return FileResponse(
        frame_path,
        media_type="image/jpeg",
        headers={"Cache-Control": "no-cache"},
    )


# File Management Routes
# Do NOT provide a response_model here, as it may be either an image
# or a converted stream and FastAPI refuses to work with Union types
# in response_model.
@search_router.get("/images/{album_key}/{path:path}", tags=["Search"])
async def serve_image(album_key: str, path: str, album_config: AlbumDep):
    """Serve images from diffe rent albums dynamically."""
    image_path = config_manager.find_image_in_album(album_key, path)
    if not image_path:
        raise HTTPException(status_code=404, detail="Image not found")

    if not validate_image_access(album_config, image_path):
        raise HTTPException(status_code=403, detail="Access denied")

    # Enforce the image-extension allowlist on any file-serving endpoint.
    # ``add_album`` accepts arbitrary absolute ``image_paths``; without this
    # check a caller could point an album at ``/etc`` and then read
    # ``/images/<key>/passwd`` (the ``is_relative_to`` guard above only
    # checks *location*, not type).
    if image_path.suffix.lower() not in SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=403, detail="Unsupported image type")

    if not image_path.exists() or not image_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    if image_path.suffix.lower() in {".heic", ".heif"}:
        return serve_image_with_conversion(image_path)
    else:
        return FileResponse(image_path)


@search_router.get("/videos/{album_key}/{path:path}", tags=["Search"])
async def serve_video(
    album_key: str, path: str, album_config: AlbumDep
) -> FileResponse:
    """Serve a video file's bytes for playback.

    A separate route rather than a widened ``/images/`` allowlist.
    ``SUPPORTED_EXTENSIONS`` guards ``serve_image`` against the
    ``add_album(image_paths=["/etc"])`` -> ``GET /images/<key>/passwd``
    arbitrary-file-read chain; widening it to admit videos would have loosened
    that guard as a side effect.  Two routes, two allowlists, neither able to
    serve the other's file types.

    Returns a ``FileResponse`` specifically: Starlette implements HTTP Range
    on it, which is what makes the ``<video>`` scrubber able to seek.  A
    ``StreamingResponse`` (as the HEIC conversion path uses) has no range
    support and would silently break seeking.
    """
    # A NUL byte makes Path.resolve() raise ValueError (while .exists() merely
    # returns False), and validate_image_access below calls resolve() — so
    # without this the request escapes every handler as a 500 with a traceback
    # instead of the 403/404 this route is designed to return.
    if "\x00" in path:
        raise HTTPException(status_code=404, detail="Video not found")

    video_path = config_manager.find_image_in_album(album_key, path)
    if not video_path:
        raise HTTPException(status_code=404, detail="Video not found")

    if not validate_image_access(album_config, video_path):
        raise HTTPException(status_code=403, detail="Access denied")

    if not is_video(video_path):
        raise HTTPException(status_code=403, detail="Unsupported video type")

    if not video_path.exists() or not video_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    return FileResponse(
        video_path,
        media_type=video_media_type(video_path),
        # FileResponse emits ETag/Last-Modified but implements no conditional
        # handling (only StaticFiles does), so a revalidation would re-transfer
        # the whole body. An explicit lifetime keeps a cached clip out of the
        # network entirely; the path is content-addressed by name, and an
        # edited video changes its mtime and therefore its validators.
        headers={"Cache-Control": "private, max-age=3600"},
    )


@search_router.post(
    "/download_images_zip/{album_key}",
    tags=["Search"],
)
async def download_images_zip(
    album_key: str,
    req: DownloadImagesZipRequest,
    album_config: AlbumDep,
    embeddings: EmbeddingsDep,
) -> StreamingResponse:
    """
    Download multiple images as a ZIP file.
    """
    # The archive is assembled entirely in memory, which was fine for photos
    # but is not for video: twenty bookmarked 200 MB clips would be several
    # gigabytes resident. Refuse above a ceiling rather than exhausting the
    # server.
    # Applies the same access check as the loop below, so the total only counts
    # files that would actually be written. Counting a rejected path could
    # refuse a selection that zips to nothing.
    total_bytes = 0
    for index in req.indices:
        try:
            candidate = embeddings.get_image_path(index)
            if validate_image_access(album_config, candidate) and candidate.is_file():
                total_bytes += candidate.stat().st_size
        except Exception:
            continue
    if total_bytes > _MAX_ZIP_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"That selection is {_format_bytes(total_bytes)}, over the "
                f"{_format_bytes(_MAX_ZIP_BYTES)} download limit. "
                "Select fewer files, or copy them to a folder instead."
            ),
        )

    # Create ZIP file in memory
    zip_buffer = BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
        for index in req.indices:
            try:
                image_path = embeddings.get_image_path(index)
                if not validate_image_access(album_config, image_path):
                    logger.warning(f"Access denied for image at index {index}")
                    continue
                if not image_path.exists() or not image_path.is_file():
                    logger.warning(f"Image not found at index {index}")
                    continue
                # Video containers hold already-compressed streams, so
                # deflating them burns CPU for no gain. Store them instead.
                compression = (
                    zipfile.ZIP_STORED if is_video(image_path) else zipfile.ZIP_DEFLATED
                )
                # Add file to ZIP with just the filename (not full path)
                zip_file.write(image_path, image_path.name, compress_type=compression)
            except Exception as e:
                logger.warning(f"Error adding image at index {index} to ZIP: {e}")
                continue

    zip_buffer.seek(0)
    return StreamingResponse(
        zip_buffer,
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename={album_key}_images.zip"
        },
    )


@search_router.get(
    "/image_path/{album_key}/{index}",
    response_class=PlainTextResponse,
    tags=["Search"],
)
async def get_image_path(album_key: str, index: int, embeddings: EmbeddingsDep) -> str:
    """
    Return the image path for a given index in the album.
    """
    try:
        image_path = embeddings.get_image_path(index)
        return image_path.as_posix()
    except Exception as e:
        raise HTTPException(
            status_code=404, detail=f"Image not found for index {index}: {e}"
        ) from e


class ImageIndexLookupRequest(BaseModel):
    filenames: list[str]


class ImageIndexLookupResponse(BaseModel):
    # Maps each requested filename to its album index, or null if not present.
    indices: dict[str, int | None]


@search_router.post(
    "/image_indices/{album_key}",
    response_model=ImageIndexLookupResponse,
    tags=["Search"],
)
async def lookup_image_indices(
    album_key: str,
    req: ImageIndexLookupRequest,
    embeddings: EmbeddingsDep,
) -> ImageIndexLookupResponse:
    """Resolve album indices for a batch of filenames (by basename).

    Used by the metadata drawer to decide which reference-image filenames
    correspond to images present in the current album, so they can be rendered
    as clickable thumbnails. Filenames not found in the album map to ``null``.
    Duplicate basenames in the album resolve to the first matching index.
    """
    sorted_filenames = (await embeddings.load_indexes())["sorted_filenames"]
    basename_to_index: dict[str, int] = {}
    for idx, full_path in enumerate(sorted_filenames):
        basename = Path(full_path).name
        basename_to_index.setdefault(basename, idx)

    return ImageIndexLookupResponse(
        indices={name: basename_to_index.get(name) for name in req.filenames}
    )


@search_router.get(
    "/image_by_name/{album_key}/{filename:path}",
    response_class=FileResponse,
    tags=["Search"],
)
async def get_image_by_name(
    album_key: str,
    filename: str,
    album_config: AlbumDep,
    embeddings: EmbeddingsDep,
) -> FileResponse:
    """
    Serve an image by its filename within the specified album.
    """
    if Path(filename).suffix.lower() not in SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=403, detail="Unsupported image type")

    indexes = await embeddings.load_indexes()
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
    if not validate_image_access(album_config, image_path):
        raise HTTPException(status_code=403, detail="Access denied")
    if not image_path.exists() or not image_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(image_path)


# Utility Functions
def create_search_results(
    results: list[int], scores: list[float], album_key: str
) -> SearchResultsResponse:
    """Create a standardized search results response."""
    return SearchResultsResponse(
        results=[
            SearchResult(
                index=index,
                score=float(score),
            )
            for index, score in zip(results, scores, strict=False)
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
    # Percent-encode both halves. These are interpolated straight into a URL
    # the browser will request, and ordinary filename characters break it:
    # "beach #2.mp4" makes "#2.mp4" a fragment so the server sees
    # "videos/<key>/beach " and 404s, "?" starts a query string, and a literal
    # "%" reads as a broken escape. html.escape (used on the drawer link) is a
    # different encoding entirely and does not help here. safe="/" keeps the
    # directory separators of a nested relative path intact.
    quoted_album = quote(album_key, safe="")
    quoted_path = quote(relative_path or "", safe="/")

    slide_metadata.metadata_url = f"get_metadata/{quoted_album}/{slide_metadata.index}"

    if slide_metadata.media_type == "video":
        # ``image_url`` still points at something displayable — the extracted
        # still — so every consumer that just wants a picture keeps working.
        # The playable bytes get their own field.
        slide_metadata.image_url = f"video_frame/{quoted_album}/{slide_metadata.index}"
        slide_metadata.video_url = f"videos/{quoted_album}/{quoted_path}"
        slide_metadata.description += video_external_link_html(
            slide_metadata.video_url
        )
    else:
        slide_metadata.image_url = f"images/{quoted_album}/{quoted_path}"


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
        raise HTTPException(status_code=500, detail=f"Image processing error: {e}") from e
