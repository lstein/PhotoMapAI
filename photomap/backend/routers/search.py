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
import os
import re
import zipfile
from io import BytesIO
from logging import getLogger
from pathlib import Path
from urllib.parse import quote

import numpy as np
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse
from PIL import Image, ImageCms, ImageDraw, ImageOps
from pydantic import BaseModel

from ..config import get_config_manager
from ..embeddings import SUPPORTED_EXTENSIONS, MediaFilter
from ..media_types import is_video, needs_browser_conversion, video_media_type
from ..metadata_modules import SlideSummary, video_external_link_html
from ..thumbnail_cache import thumbnail_dir, tile_hash
from ..util import is_cuda_oom
from ..video_cache import VideoFrameCache
from ..video_transcode import (
    HLS_PLAYLIST_NAME,
    TranscodeCache,
    TranscodeStatus,
    hls_source,
    release_stream,
    request_transcode,
    stream_source,
)
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
    # None means "whatever this album's encoder resolves to" — the backends
    # do not share a score scale, so a fixed number here would filter one of
    # them into silence.
    min_search_score: float | None = None
    max_search_results: int = 100
    # Optional: per-request SigLIP prompt-ensembling toggle. Frontend sources
    # this from the album's ``use_query_optimization`` setting. ``None`` keeps
    # the encoder's existing state (module default for direct callers).
    use_query_optimization: bool | None = None
    # The UI's images/videos filter. Applied before top_k so a filtered search
    # is still allowed max_search_results hits, not the filtered remainder of
    # an unfiltered top max_search_results.
    media_filter: MediaFilter = "both"


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
    album_config: AlbumDep,
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
            # Threaded like the other index readers, but behind a semaphore:
            # the loop is what serializes searches today, and a search is a
            # CLIP encode plus a full-index matmul. Letting two run at once
            # would be a new way to OOM the GPU (the handler below already
            # treats that as a live outcome), so the gate keeps concurrency
            # exactly where it was and only the blocking goes away.
            async with _search_gate():
                results, scores = await asyncio.to_thread(
                    embeddings.search_images_by_text_and_image,
                    query_image_data=query_image_data,
                    positive_query=req.positive_query,
                    negative_query=req.negative_query,
                    image_weight=req.image_weight,
                    positive_weight=req.positive_weight,
                    negative_weight=req.negative_weight,
                    # Omitted means "this album's floor" — the album knows one,
                    # resolved from its encoder when it was created. Falling
                    # straight through to the encoder default would ignore a
                    # value the user tuned.
                    minimum_score=(
                        req.min_search_score
                        if req.min_search_score is not None
                        else album_config.min_search_score
                    ),
                    top_k=req.max_search_results,
                    use_query_optimization=req.use_query_optimization,
                    media_filter=req.media_filter,
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


# Process-wide gate around search. Created lazily on first use because
# asyncio.Semaphore wants a running event loop, matching the indexing and
# scan semaphores in embeddings.py.
_search_semaphore: asyncio.Semaphore | None = None


def _search_gate() -> asyncio.Semaphore:
    global _search_semaphore
    if _search_semaphore is None:
        _search_semaphore = asyncio.Semaphore(1)
    return _search_semaphore


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
    # Threaded for the same reason as /image_info/ below. This one matters
    # most: the slideshow calls it per slide, so it is usually the endpoint
    # that *takes* the cold miss after an album switch or an index rewrite.
    slide_metadata = await asyncio.to_thread(embeddings.retrieve_image, index)
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


# Same reasoning as /video_frame below, and the same answer: this URL is keyed
# by *index*, so it designates a different file the moment a delete or reindex
# reorders the album, and the frame-selection generation can change the tile
# for a file that has not moved at all. Only the grid busts its own URL; the
# UMAP hover popup, the landmark overlay, the back flyout and the reference
# strip do not, so anything cacheable here is served stale to four consumers.
#
# An earlier attempt used max-age=3600 to avoid re-transferring tiles, since
# FileResponse answers no conditional requests. That made the common case
# worse, not better: a freshly rebuilt tile has a near-zero heuristic lifetime
# and would have been revalidated within seconds, and pinning it for an hour
# is exactly how a deleted image goes on being shown. The grid already
# re-fetches every tile per page load through its cache buster, so the
# bandwidth this would have saved is mostly not there to save.
_THUMBNAIL_CACHE_HEADERS = {"Cache-Control": "no-cache"}


def _thumbnail_response(request: Request, path: Path) -> Response:
    """A tile, or a 304 if the caller already has it.

    ``no-cache`` above means the browser revalidates every time, and
    FileResponse implements no conditional handling of its own, so without
    this every revalidation re-transfers the whole PNG — a hundred of them on
    one grid page.

    The bytes are read here rather than handed to FileResponse, for two
    reasons. FileResponse stats the file again when it sends, so a tile the
    thumbnail sweep unlinks in that window raises RuntimeError out of the
    handler and the browser gets a 500 where it used to get a picture; the
    sweep is new, so that window is new. And an ETag over the content rather
    than over the stat means a tile rebuilt byte-identically — the common case
    after a reindex that changed nothing about this image — still answers 304
    instead of re-sending. Tiles are capped at _MAX_THUMB_SIZE on a side, so
    holding one in memory is a PNG of at most a few megabytes.
    """
    try:
        payload = path.read_bytes()
    except OSError:
        # Swept between the freshness check and here. Nothing to serve, and
        # the next request rebuilds it; 404 rather than a 500 so it reads as
        # a missing tile instead of a broken server.
        raise HTTPException(status_code=404, detail="Thumbnail is no longer available") from None

    etag = f'"{hashlib.md5(payload, usedforsecurity=False).hexdigest()}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={**_THUMBNAIL_CACHE_HEADERS, "etag": etag})
    return Response(
        content=payload,
        media_type="image/png",
        headers={**_THUMBNAIL_CACHE_HEADERS, "etag": etag},
    )


@search_router.get("/thumbnails/{album_key}/{index}", tags=["Search"])
async def serve_thumbnail(
    request: Request,
    album_key: str,
    index: int,
    album_config: AlbumDep,
    embeddings: EmbeddingsDep,
    size: int = 256,
    color: str | None = None,
    radius: int = 12,  # Add a radius parameter for rounded corners
) -> Response:
    """Serve a reduced-size thumbnail for an image by index, with optional colored border."""
    if size <= 0 or size > _MAX_THUMB_SIZE:
        raise HTTPException(status_code=400, detail="Invalid thumbnail size")
    if radius < 0 or radius > _MAX_THUMB_RADIUS:
        raise HTTPException(status_code=400, detail="Invalid thumbnail radius")
    if color is not None and not _COLOR_RE.match(color):
        raise HTTPException(status_code=400, detail="Invalid color parameter")

    try:
        # A thumbnail grid fires this many times at once; on a cold index
        # every one of them would otherwise be a full np.load on the loop.
        image_path = await asyncio.to_thread(embeddings.get_image_path, index)
    except Exception as e:
        raise HTTPException(
            status_code=404, detail=f"Image not found for index {index}: {e}"
        ) from e

    if not validate_image_access(album_config, image_path):
        raise HTTPException(status_code=403, detail="Access denied")

    index_path = Path(album_config.index)
    thumb_dir = thumbnail_dir(index_path)
    thumb_dir.mkdir(exist_ok=True)

    relative_path = config_manager.get_relative_path(str(image_path), album_key)
    if relative_path is None:
        # ``get_relative_path`` returns ``None`` only when the image falls
        # outside every configured ``image_paths`` entry — i.e. an album
        # mis-configuration, not a user-supplied bad input.
        raise HTTPException(status_code=500, detail="Image path is not inside the album")

    # Shared with the sweeper in thumbnail_cache, which has to reproduce this
    # digest exactly: a second copy of the rule here would drift the first
    # time either side changed, and the sweep would then either delete live
    # tiles or keep dead ones forever. See tile_hash for why the whole
    # relative path is hashed and why a video's generation rides along.
    rel_hash = tile_hash(relative_path, video=is_video(image_path))
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
            return _thumbnail_response(request, thumb_path.with_suffix(".png"))
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

    return _thumbnail_response(request, thumb_path.with_suffix(".png"))


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
        video_path = await asyncio.to_thread(embeddings.get_image_path, index)
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
async def serve_image(album_key: str, path: str, album_config: AlbumDep, original: bool = False):
    """Serve images from different albums dynamically.

    Formats browsers cannot render are converted to PNG unless ``original`` is
    set, which the download button uses so a saved ``.tif`` is the user's file
    rather than a flattened, first-page-only PNG under the same name.
    """
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

    if needs_browser_conversion(image_path) and not original:
        # Decoding a large scanned TIFF takes long enough to stall every other
        # request if done on the loop, so it runs in a worker thread.
        return await asyncio.to_thread(serve_image_with_conversion, image_path)
    return FileResponse(image_path)


def _resolve_album_video(album_key: str, path: str, album_config) -> Path:
    """Resolve ``path`` inside ``album_key`` to a video on disk, or raise.

    Every video route shares this preamble, and the sharing is the point: the
    checks are the arbitrary-file-read defense, not a convenience. Duplicating
    them per route is how one of them ends up missing the ``is_video`` gate
    and turns ``add_album(image_paths=["/etc"])`` into ``GET
    /prepare_video/<key>/passwd``.
    """
    # A NUL byte makes Path.resolve() raise ValueError (while .exists() merely
    # returns False), and validate_image_access below calls resolve() — so
    # without this the request escapes every handler as a 500 with a traceback
    # instead of the 403/404 these routes are designed to return.
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

    return video_path


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
    video_path = _resolve_album_video(album_key, path, album_config)

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


@search_router.post("/prepare_video/{album_key}/{path:path}", tags=["Search"])
async def prepare_video(
    album_key: str, path: str, album_config: AlbumDep
) -> TranscodeStatus:
    """Ensure a browser-playable copy of this video exists, and report progress.

    POST because the first call starts work, but it is idempotent and doubles
    as the poll: the player calls it about once a second while its progress
    panel is up, and those calls are also what tell the backend somebody is
    still waiting (see ``video_transcode``'s abandonment rule). Returns
    immediately in every case; the conversion runs on a worker thread.

    Only ``state == "ready"`` carries a ``url``, and it points at
    ``/transcoded_video/`` rather than the original — the source bytes are
    exactly what the browser could not play.
    """
    video_path = _resolve_album_video(album_key, path, album_config)
    status = await asyncio.to_thread(request_transcode, album_key, video_path)
    quoted_album = quote(album_key, safe="")
    quoted_path = quote(path, safe="/")
    if status.state == "ready":
        status.url = f"transcoded_video/{quoted_album}/{quoted_path}"
    else:
        if status.streamable:
            status.stream_url = f"streaming_video/{quoted_album}/{quoted_path}"
        if status.hls_streamable and status.hls_token:
            status.hls_url = (
                f"streaming_hls/{quoted_album}/{quoted_path}/hls/"
                f"{quote(status.hls_token, safe='')}/{HLS_PLAYLIST_NAME}"
            )
    return status


# The only names an HLS directory serves: the playlist, the init segment, and
# the numbered media segments ffmpeg names after the playlist. Anything else
# — a "..", the playlist's ".tmp" mid-rewrite — is refused.
_HLS_NAME_RE = re.compile(r"^(index\.m3u8|init\.m4s|index\d+\.m4s)$")


def _start_at_the_beginning(playlist: bytes) -> bytes:
    """Tell the player to start this playlist at 0:00.

    A playlist with no ``#EXT-X-ENDLIST`` yet is a live one to a player, and
    a live stream starts a few segments back from the newest — so the viewer
    would join a conversion somewhere in the middle, and Chrome's player,
    given a playlist shorter than that offset, fails outright. ffmpeg has no
    option for the ``EXT-X-START`` tag that says otherwise, so it is added
    here, right after the header.
    """
    header = b"#EXTM3U"
    if not playlist.startswith(header) or b"#EXT-X-START:" in playlist:
        return playlist
    # In the playlist's own line ending, so a CRLF playlist does not come out
    # with one LF line in it.
    rest = playlist[len(header) :]
    eol = b"\r\n" if rest.startswith(b"\r\n") else b"\n"
    return header + eol + b"#EXT-X-START:TIME-OFFSET=0,PRECISE=YES" + rest


@search_router.get("/streaming_hls/{album_key}/{path:path}/hls/{token}/{name}", tags=["Search"])
async def stream_video_conversion_hls(
    album_key: str, path: str, token: str, name: str, album_config: AlbumDep
) -> Response:
    """The HLS form of a conversion in progress, for Apple's player.

    Every browser on iOS and iPadOS, and Safari, refuses the growing MP4 that
    ``/streaming_video/`` serves — it insists on knowing a file's length — but
    plays an HLS playlist that is still being appended to. The file name is
    last in the URL so the playlist's relative segment names resolve back to
    this route.

    ``token`` names one conversion run (see ``video_transcode._hls_streams``).
    That is what makes caching segments safe: every run numbers its segments
    from index0, so without it a re-converted video would be spliced together
    from the old run's cached segments and the new run's.

    The playlist is never cached (it grows); segments are immutable once
    listed. Guarded by the album resolution like the other video routes.
    """
    if not _HLS_NAME_RE.match(name):
        raise HTTPException(status_code=404, detail="Not part of a conversion")
    video_path = _resolve_album_video(album_key, path, album_config)
    hls_dir = await asyncio.to_thread(hls_source, album_key, video_path, token)
    if hls_dir is None:
        raise HTTPException(status_code=404, detail="This video is not being converted")
    file = hls_dir / name
    if name == HLS_PLAYLIST_NAME:
        try:
            playlist = await asyncio.to_thread(file.read_bytes)
        except OSError:
            raise HTTPException(status_code=404, detail="This video is not being converted") from None
        return Response(
            _start_at_the_beginning(playlist),
            media_type="application/vnd.apple.mpegurl",
            headers={"Cache-Control": "no-store"},
        )
    # Read whole rather than handed to FileResponse: a segment is two seconds
    # of video, and the directory can be deleted between a FileResponse's
    # existence check and its open — a 500 instead of a 404. A short read
    # also holds the file open only briefly, which is what lets ffmpeg's
    # playlist rename and the lingering directory's removal succeed on
    # Windows.
    try:
        segment = await asyncio.to_thread(file.read_bytes)
    except OSError:
        raise HTTPException(status_code=404, detail="No such segment") from None
    # video/iso.segment, the registered type for an fMP4 segment, and not
    # video/mp4: Chrome's native HLS player takes video/mp4 at its word, tries
    # to parse a bare fragment as a whole MP4, and fails the stream outright
    # (DEMUXER_ERROR_COULD_NOT_PARSE). Measured; Apple's player accepts both.
    return Response(
        segment, media_type="video/iso.segment", headers={"Cache-Control": "private, max-age=3600"}
    )


# Read size for tailing a conversion in progress, and how long to wait at the
# end of what has been written before looking again. ffmpeg appends a
# fragment every couple of seconds, so a quarter second is plenty responsive.
_STREAM_CHUNK_BYTES = 256 * 1024
_STREAM_POLL_SECONDS = 0.25

# Longest a closed-range request waits for its first byte to be written.
_STREAM_RANGE_WAIT_SECONDS = 10.0
# Most a closed-range request is answered with at once. A 206 may be shorter
# than asked for, and the client asks again for the rest.
_STREAM_RANGE_MAX_BYTES = 8 * 1024 * 1024

_RANGE_RE = re.compile(r"^bytes=(\d+)-(\d*)$")


@search_router.get("/streaming_video/{album_key}/{path:path}", tags=["Search"])
async def stream_video_conversion(
    album_key: str, path: str, request: Request, album_config: AlbumDep
) -> Response:
    """Stream a conversion while it is still being produced.

    Tails the growing fragmented MP4 that ``video_transcode`` writes next to
    the cache file during a re-encode, so the player can start within seconds
    instead of waiting minutes for the finished file. It has no length and no
    seeking — the player swaps to ``/transcoded_video/`` for that as soon as
    the conversion is done.

    Range handling is deliberately narrow, and measured rather than guessed:

    * no Range, or ``bytes=0-`` (what Chrome and Firefox send): a plain 200
      that follows the file as it grows. Answering those with a 206 of what
      exists so far makes both browsers fail outright.
    * a closed range such as Safari's ``bytes=0-1`` probe: exactly those
      bytes, with an unknown total (``/*``).
    * an open range from anywhere else — a browser trying to resume mid-file:
      416. The stream cannot honour it, and the player treats the resulting
      error as "wait for the finished file".

    Guarded by the album resolution like the other two video routes.
    """
    video_path = _resolve_album_video(album_key, path, album_config)
    source = await asyncio.to_thread(stream_source, album_key, video_path)
    if source is None:
        raise HTTPException(status_code=404, detail="This video is not being converted")
    stream_path, still_writing = source

    start, end = 0, None
    range_header = request.headers.get("range")
    if range_header:
        match = _RANGE_RE.match(range_header.strip())
        if match is None:
            raise HTTPException(status_code=416, detail="Unsupported range")
        start = int(match.group(1))
        end = int(match.group(2)) if match.group(2) else None
        if end is None and start != 0:
            raise HTTPException(status_code=416, detail="A conversion in progress cannot be resumed")
        if end is not None and end < start:
            raise HTTPException(status_code=416, detail="Unsupported range")

    # Opened here, before any response starts: the job deletes the file the
    # moment ffmpeg exits, and an open handle is what keeps it readable (on
    # POSIX) for a reader that is still behind.
    try:
        handle = await asyncio.to_thread(open, stream_path, "rb")
    except OSError:
        raise HTTPException(status_code=404, detail="This video is not being converted") from None

    headers = {"Cache-Control": "no-store"}

    if end is not None:
        try:
            data = await _read_range(handle, start, end, still_writing)
        finally:
            handle.close()
            release_stream(album_key, video_path, stream_path)
        if not data:
            raise HTTPException(status_code=416, detail="Range not yet available")
        headers["Content-Range"] = f"bytes {start}-{start + len(data) - 1}/*"
        return Response(data, status_code=206, media_type="video/mp4", headers=headers)

    async def follow():
        try:
            while True:
                chunk = await asyncio.to_thread(handle.read, _STREAM_CHUNK_BYTES)
                if chunk:
                    yield chunk
                    continue
                if not still_writing():
                    # ffmpeg has exited; whatever it wrote after our last read
                    # is already on disk.
                    while chunk := await asyncio.to_thread(handle.read, _STREAM_CHUNK_BYTES):
                        yield chunk
                    return
                await asyncio.sleep(_STREAM_POLL_SECONDS)
        finally:
            # Synchronous, both of them: this runs when the client disconnects,
            # inside an already-cancelled scope where any await is cancelled
            # again before it can do anything. Both are quick.
            handle.close()
            release_stream(album_key, video_path, stream_path)

    return StreamingResponse(follow(), media_type="video/mp4", headers=headers)


async def _read_range(handle, start: int, end: int, still_writing) -> bytes:
    """Up to ``start``..``end`` of a growing file.

    Waits only for ``start`` itself to exist, then answers with what is there
    — capped, so a request naming the whole film cannot pull a partial copy
    of it into memory at once. Empty when not even ``start`` exists.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + _STREAM_RANGE_WAIT_SECONDS
    wanted = min(end - start + 1, _STREAM_RANGE_MAX_BYTES)
    while True:
        # fstat, not stat: the job may already have unlinked the name.
        size = (await asyncio.to_thread(os.fstat, handle.fileno())).st_size
        if size > start or not still_writing() or loop.time() >= deadline:
            break
        await asyncio.sleep(_STREAM_POLL_SECONDS)

    def read() -> bytes:
        handle.seek(start)
        return handle.read(wanted)

    return await asyncio.to_thread(read)


@search_router.get("/transcoded_video/{album_key}/{path:path}", tags=["Search"])
async def serve_transcoded_video(
    album_key: str, path: str, album_config: AlbumDep
) -> FileResponse:
    """Serve the converted copy of a video, if one has been produced.

    Guarded by the same resolution as the original bytes rather than by the
    cache key alone: the cache is addressed by a digest of the *source* path,
    so serving straight from it would let anyone who can name a file get its
    converted contents without passing the album's access check.

    A ``FileResponse`` again, for Range support — being able to seek is most
    of the reason the conversion is written to disk instead of piped.
    """
    video_path = _resolve_album_video(album_key, path, album_config)
    cached = await asyncio.to_thread(TranscodeCache(album_key).get, video_path)
    if cached is None:
        raise HTTPException(
            status_code=404, detail="This video has not been converted for playback"
        )

    return FileResponse(
        cached,
        media_type="video/mp4",
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
    # Prime the index off the loop once. Both loops below resolve paths
    # through get_image_path, which reads the same cached index -- with it
    # warm they are dictionary lookups, so threading each of them
    # individually would buy nothing and cost a hop per file.
    #
    # Best-effort: both loops already treat an unreadable index as "no
    # files matched" and return an empty archive. Letting a missing index
    # escape from here would turn that into a 500.
    try:
        await embeddings.load_indexes()
    except Exception as e:  # noqa: BLE001 - priming only; the loops re-raise
        logger.debug(f"Could not prime the index for {album_key}: {e}")

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
        image_path = await asyncio.to_thread(embeddings.get_image_path, index)
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
        # Where the player asks for a playable copy when the original turns
        # out not to be one. Handed over rather than assembled in the frontend
        # so the route shape stays a backend concern, and so a payload from an
        # older server (empty string) degrades to the download-only fallback
        # instead of a 404 the player would have to interpret.
        slide_metadata.video_transcode_url = (
            f"prepare_video/{quoted_album}/{quoted_path}"
        )
        slide_metadata.description += video_external_link_html(
            slide_metadata.video_url
        )
    else:
        slide_metadata.image_url = f"images/{quoted_album}/{quoted_path}"


# Modes PNG can store as-is. Anything else — CMYK and LAB scans, big-endian
# 16-bit and 32-bit TIFFs — makes ``Image.save(format="PNG")`` raise or, via a
# naive ``convert``, clip to solid white, so :func:`_png_safe` handles it first.
_PNG_SAFE_MODES = frozenset({"1", "L", "LA", "P", "RGB", "RGBA", "I;16"})


def _png_safe(im: Image.Image) -> Image.Image:
    """Return ``im`` in a mode PNG can store, preserving what it depicts."""
    if im.mode in _PNG_SAFE_MODES:
        return im
    if im.mode.startswith("I") or im.mode == "F":
        # Pillow's own conversions clip anything above 255 (or 65535), which
        # turns a 16-bit big-endian or 32-bit scan into a blank white page.
        # Rescale into 16-bit greyscale instead. Integer data already inside
        # the 16-bit range and floats in [0, 1] keep their absolute levels;
        # anything else is stretched over its own range.
        arr = np.asarray(im).astype(np.float64)
        lo, hi = float(arr.min()), float(arr.max())
        if im.mode == "F" and lo >= 0.0 and hi <= 1.0:
            arr = arr * 65535.0
        elif im.mode == "F" or lo < 0 or hi > 65535:
            arr = (arr - lo) * (65535.0 / (hi - lo)) if hi > lo else np.zeros_like(arr)
        return Image.fromarray(np.rint(arr).astype(np.uint16))
    source_mode = im.mode
    icc = im.info.get("icc_profile")
    target = "RGBA" if "A" in im.getbands() else "RGB"
    converted = None
    if icc and target == "RGB":
        # A print scan's embedded CMYK profile gives far truer colors than
        # Pillow's naive CMYK->RGB arithmetic.
        try:
            converted = ImageCms.profileToProfile(
                im,
                ImageCms.ImageCmsProfile(BytesIO(icc)),
                ImageCms.createProfile("sRGB"),
                outputMode="RGB",
            )
        except (ImageCms.PyCMSError, OSError, ValueError):
            converted = None
    if converted is None:
        converted = im.convert(target)
    if source_mode != converted.mode:
        # The source's profile describes the old color space; carried into
        # the PNG it would make browsers misinterpret the new pixels.
        converted.info.pop("icc_profile", None)
    return converted


def serve_image_with_conversion(image_path: Path) -> StreamingResponse:
    """Serve an image browsers cannot render (HEIC, TIFF) re-encoded as PNG,
    with EXIF rotation applied. Blocking: call it off the event loop."""
    try:
        with Image.open(image_path) as im:
            im = ImageOps.exif_transpose(im)
            im = _png_safe(im)
            buf = BytesIO()
            format = "PNG"
            # Fast compression: a 24 MP scan takes several seconds to encode
            # at the default level, and these bytes only cross localhost.
            im.save(buf, format=format, compress_level=1)
            buf.seek(0)
            return StreamingResponse(buf, media_type=f"image/{format.lower()}")
    except Exception as e:
        logger.warning(f"Error converting image {image_path} for display: {e}")
        raise HTTPException(status_code=500, detail=f"Image processing error: {e}") from e
