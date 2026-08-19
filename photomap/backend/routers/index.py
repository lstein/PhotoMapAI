"""
photomap.backend.routers.index
This module contains the index-related API endpoints for the Clipslide backend.
It allows creating, deleting, and checking the existence of embeddings indices for albums.
"""

import logging
import os
import shutil
from pathlib import Path
from typing import NamedTuple

import numpy as np
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from send2trash import send2trash
from send2trash.exceptions import TrashPermissionError

from .. import invokeai_client
from ..config import get_config_manager
from ..embeddings import LAST_UPDATED_FILENAME, Embeddings, peek_encoder_spec
from ..media_types import is_video
from ..progress import IndexingCancelled, progress_tracker
from ..video_cache import VideoFrameCache
from .album import (
    AlbumDep,
    EmbeddingsDep,
    require_no_lock,
    validate_album_exists,
    validate_image_access,
)

index_router = APIRouter()

logger = logging.getLogger(__name__)
config_manager = get_config_manager()


class ProgressResponse(BaseModel):
    album_key: str
    status: str
    current_step: str
    images_processed: int
    total_images: int
    progress_percentage: float
    elapsed_time: float
    estimated_time_remaining: float | None
    error_message: str | None = None
    warning_message: str | None = None


class UpdateIndexRequest(BaseModel):
    album_key: str


class DeleteImagesRequest(BaseModel):
    indices: list[int]
    move_to_trash: bool = True


class MoveImagesRequest(BaseModel):
    indices: list[int]
    target_directory: str


class CopyImagesRequest(BaseModel):
    indices: list[int]
    target_directory: str


class EmbeddingsIndexMetadata(BaseModel):
    filename_count: int
    embeddings_path: str
    last_modified: float
    # Broken out so the album card can say "120 images, 4 videos" rather than
    # leaving the user to wonder why the single count jumped. Derived from the
    # filename suffixes, so indexes written before video support report
    # image_count == filename_count and video_count == 0.
    image_count: int = 0
    video_count: int = 0


# Note: How check_album_lock is used in this file:
# For any state-changing operations, such as starting an index update or deleting an index,
# if the environment variable PHOTOMAP_ALBUM_LOCKED is set, the operation is forbidden.
# For read-only operations, such as checking if an index exists or getting index metadata,
# the album_key is checked against the value of PHOTOMAP_ALBUM_LOCKED, and if they don't match, the operation is forbidden.


# Index Management Routes
@index_router.post(
    "/update_index_async/",
    response_model=dict,
    status_code=202,
    tags=["Index"],
    dependencies=[Depends(require_no_lock)],
)
async def update_index_async(
    background_tasks: BackgroundTasks,
    req: UpdateIndexRequest,
) -> dict:
    """Start an asynchronous index update for the specified album."""
    album_key = req.album_key
    try:
        if progress_tracker.is_running(album_key):
            raise HTTPException(
                status_code=409,
                detail=f"Index update already running for album '{album_key}'",
            )

        album_config = validate_album_exists(album_key)
        # Register the run before the background task is even scheduled, so
        # the very first progress poll sees a live operation instead of
        # "idle": board resolution and loading a large existing index both
        # happen before the first in-task start_operation, and a poller that
        # reads "idle" during that window paints "No operation in progress".
        # It also guarantees set_error() has an entry to land on if the task
        # dies before scanning starts (e.g. InvokeAI unreachable).
        progress_tracker.start_operation(album_key, 0, "scanning")
        progress_tracker.update_progress(album_key, 0, "Preparing index update...")
        background_tasks.add_task(
            _update_index_background_async, album_key, album_config
        )

        return {
            "success": True,
            "message": f"Index update for album '{album_key}' started in background",
            "album_key": album_key,
            "task_id": album_key,  # This is the convention.
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to start background index update: {str(e)}"
        ) from e


@index_router.delete(
    "/remove_index/{album_key}", tags=["Index"], dependencies=[Depends(require_no_lock)]
)
async def remove_index(album_key: str) -> JSONResponse:
    """Remove the embeddings index for the specified album."""
    try:
        album_config = config_manager.get_album(album_key)
        if not album_config:
            raise HTTPException(
                status_code=404, detail=f"Album '{album_key}' not found"
            )

        index_path = Path(album_config.index).resolve()
        if not index_path.exists():
            raise HTTPException(status_code=404, detail="Index file does not exist")

        # Remove the index file
        index_path.unlink()
        logger.info(f"Removed index file: {index_path}")

        return JSONResponse(
            content={
                "success": True,
                "message": f"Removed index for album '{album_key}'",
            },
            status_code=200,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to remove index: {str(e)}") from e


@index_router.get(
    "/index_progress/{album_key}", response_model=ProgressResponse, tags=["Index"]
)
async def get_index_progress(
    album_key: str, album_config: AlbumDep
) -> ProgressResponse:
    """Get the current progress of an index update operation."""
    # ``album_config`` is unused — taking it as a Depends parameter runs
    # ``validate_album_exists`` (lock check + 404 if missing) before the body.
    del album_config
    try:
        progress = progress_tracker.get_progress(album_key)
        if not progress:
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

        # Ensure numbers are always valid
        images_processed = progress.images_processed or 0
        total_images = progress.total_images or 1  # Avoid division by zero

        return ProgressResponse(
            album_key=progress.album_key,
            status=progress.status.value,
            current_step=progress.current_step,
            images_processed=images_processed,
            total_images=total_images,
            progress_percentage=(
                progress.progress_percentage
                if hasattr(progress, "progress_percentage")
                else 0.0
            ),
            elapsed_time=progress.elapsed_time,
            estimated_time_remaining=progress.estimated_time_remaining,
            error_message=progress.error_message,
            warning_message=progress.warning_message,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get progress: {str(e)}") from e


@index_router.delete("/cancel_index/{album_key}", tags=["Index"])
async def cancel_index_operation(album_key: str, album_config: AlbumDep) -> dict:
    """Cancel an ongoing index operation.

    Sets the cooperative-cancel flag in ``progress_tracker``; the indexing
    loop polls it between batches via the per-image progress callback and
    raises :class:`IndexingCancelled`, which the background task catches
    cleanly. The status text is flipped here too so the frontend's poll
    sees the cancel immediately, even before the next batch boundary.
    """
    del album_config  # See get_index_progress above.
    try:
        if not progress_tracker.is_running(album_key):
            raise HTTPException(
                status_code=404, detail=f"No active operation for album '{album_key}'"
            )

        progress_tracker.request_cancel(album_key)
        progress_tracker.set_error(album_key, "Indexing cancelled by user")

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
        ) from e


# Return true if the index exists for the specified album
@index_router.get("/index_exists/{album_key}", tags=["Index"])
async def index_exists(album_config: AlbumDep) -> dict:
    """Check if the index exists for the specified album."""
    index_path = Path(album_config.index)
    return {"exists": index_path.exists()}


# Return Embeddings index metadata for the specified album
@index_router.get(
    "/index_metadata/{album_key}",
    response_model=EmbeddingsIndexMetadata,
    tags=["Albums"],
)
async def index_metadata(album_config: AlbumDep) -> EmbeddingsIndexMetadata:
    """Get metadata about the embeddings index for the specified album."""
    index_path = Path(album_config.index)
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="Index file does not exist")

    # "Last updated" is when an update operation last COMPLETED, not when the
    # .npz content last changed — a no-change update skips the save, and the
    # card shouldn't look stale right after a successful refresh. The marker
    # is absent for indexes predating it; fall back to the .npz mtime.
    last_modified = index_path.stat().st_mtime
    marker = index_path.parent / LAST_UPDATED_FILENAME
    if marker.exists():
        last_modified = max(last_modified, marker.stat().st_mtime)
    filenames = Embeddings.open_cached_embeddings(index_path)["filenames"]
    filename_count = len(filenames)
    video_count = sum(1 for f in filenames if is_video(Path(str(f))))

    return EmbeddingsIndexMetadata(
        filename_count=filename_count,
        embeddings_path=str(index_path),
        last_modified=last_modified,
        image_count=filename_count - video_count,
        video_count=video_count,
    )


async def _delete_board_media(album_config, media_path: Path) -> None:
    """Delete one file of an InvokeAI-board album through InvokeAI's API.

    Images and videos are distinct resources over there, with their own
    delete endpoints, and a mis-dispatch fails *quietly*: InvokeAI's
    ``DELETE /images/i/{name}`` wraps its lookup in a bare ``except`` and
    answers 200 with an empty ``deleted_images`` for a name it does not know,
    so handing it a video name would read as success. The row would vanish
    from the local index while the video stayed on the board, then reappear
    on the next re-index. Dispatch on the suffix so each name reaches its own
    endpoint.
    """
    if is_video(media_path):
        await invokeai_client.delete_video(
            album_config.invokeai_url,
            media_path.name,
            album_config.invokeai_username,
            album_config.invokeai_password,
        )
    else:
        await invokeai_client.delete_image(
            album_config.invokeai_url,
            media_path.name,
            album_config.invokeai_username,
            album_config.invokeai_password,
        )


def _remove_image_file(image_path: Path, move_to_trash: bool) -> None:
    """Trash or unlink ``image_path``, translating OS failures into HTTP
    errors whose ``detail`` tells the user what to fix.

    Without this, a read-only folder surfaced as a bare
    "HTTP 500 Internal Server Error" dialog with no hint that it was a
    permissions problem.
    """
    try:
        if move_to_trash:
            send2trash(str(image_path))
        else:
            image_path.unlink()
    except TrashPermissionError as e:
        raise HTTPException(
            status_code=403,
            detail=(
                f"Cannot move '{image_path.name}' to the trash: permission denied "
                "creating or writing the trash folder. Fix its permissions, or "
                'switch "When deleting" to "Just Delete" in Settings to delete '
                "the file permanently."
            ),
        ) from e
    except PermissionError as e:
        raise HTTPException(
            status_code=403,
            detail=(
                f"Cannot delete '{image_path.name}': permission denied. "
                "The PhotoMap server needs write permission on the image file "
                "and its containing folder."
            ),
        ) from e
    except OSError as e:
        action = "move to the trash" if move_to_trash else "delete"
        reason = e.strerror or str(e)
        hint = (
            ' Switching "When deleting" to "Just Delete" in Settings may help.'
            if move_to_trash
            else ""
        )
        raise HTTPException(
            status_code=500,
            detail=f"Could not {action} '{image_path.name}': {reason}.{hint}",
        ) from e


def _discard_cached_frame(album_key: str, path: Path) -> None:
    """Remove a deleted video's cached still. Never raises."""
    if not is_video(path):
        return
    try:
        VideoFrameCache(album_key).discard(path)
    except Exception as e:
        logger.debug(f"Could not discard cached frame for {path}: {e}")


@index_router.delete(
    "/delete_image/{album_key}/{index}",
    tags=["Index"],
    dependencies=[Depends(require_no_lock)],
)
async def delete_image(
    album_key: str,
    index: int,
    album_config: AlbumDep,
    embeddings: EmbeddingsDep,
    move_to_trash: bool = True,
) -> JSONResponse:
    """Delete an image file."""
    try:
        image_path = embeddings.get_image_path(index)

        if not validate_image_access(album_config, image_path):
            raise HTTPException(status_code=403, detail="Access denied")

        if album_config.source_type == "invokeai_board":
            # Board images belong to InvokeAI: deleting the file directly
            # would leave a dangling row in InvokeAI's database, so route
            # the deletion through its API (which also removes the file).
            # ``move_to_trash`` has no meaning here and is ignored.
            await _delete_board_media(album_config, image_path)
            # Same reason as the non-board branch below: a board album can
            # hold videos, and their extracted stills outlive the row unless
            # they are discarded here.
            _discard_cached_frame(album_key, image_path)
            embeddings.remove_image_from_embeddings(index)
            return JSONResponse(
                content={
                    "success": True,
                    "message": f"Deleted {image_path.name} via InvokeAI",
                },
                status_code=200,
            )

        if not image_path.exists() or not image_path.is_file():
            raise HTTPException(status_code=404, detail="File not found")

        print(f"{'Trashing' if move_to_trash else 'Deleting'} image: {image_path}")
        _remove_image_file(image_path, move_to_trash)

        # Drop the extracted still too. The index-time sweep would collect it
        # eventually, but not until the next update — and a stale frame for a
        # deleted file is exactly the kind of thing users notice.
        _discard_cached_frame(album_key, image_path)

        # Remove from embeddings
        embeddings.remove_image_from_embeddings(index)

        return JSONResponse(
            content={"success": True, "message": f"Deleted {image_path}"},
            status_code=200,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete file: {str(e)}") from e


@index_router.post(
    "/delete_images/{album_key}",
    tags=["Index"],
    dependencies=[Depends(require_no_lock)],
)
async def delete_images(
    album_key: str,
    req: DeleteImagesRequest,
    album_config: AlbumDep,
    embeddings: EmbeddingsDep,
) -> JSONResponse:
    """Delete a batch of images with a single embeddings-index rewrite.

    Repeated calls to ``delete_image`` rewrite the entire .npz once per
    image; this endpoint removes the files first and then drops all of
    their rows in one rewrite, so a multi-select delete costs the same
    index I/O as a single deletion.
    """
    if not req.indices:
        raise HTTPException(status_code=400, detail="No indices provided")

    try:
        indices = sorted(set(req.indices))

        # Resolve every index against one snapshot of the sort order before
        # anything is deleted — the indices all refer to the pre-delete
        # ordering, so nothing here needs reverse-order shifting.
        image_paths: dict[int, Path] = {}
        errors: list[str] = []
        for index in indices:
            try:
                image_paths[index] = embeddings.get_image_path(index)
            except IndexError:
                errors.append(f"Index {index}: out of range")

        deleted_indices: list[int] = []
        deleted_files: list[str] = []
        for index, image_path in image_paths.items():
            try:
                if not validate_image_access(album_config, image_path):
                    errors.append(f"Index {index}: Access denied")
                    continue

                if album_config.source_type == "invokeai_board":
                    # Board images belong to InvokeAI: deleting the file
                    # directly would leave a dangling row in InvokeAI's
                    # database, so route each deletion through its API
                    # (which also removes the file). ``move_to_trash`` has
                    # no meaning here and is ignored.
                    await _delete_board_media(album_config, image_path)
                else:
                    if not image_path.exists() or not image_path.is_file():
                        errors.append(f"Index {index}: File not found")
                        continue
                    if req.move_to_trash:
                        send2trash(str(image_path))
                    else:
                        image_path.unlink()

                _discard_cached_frame(album_key, image_path)
                deleted_indices.append(index)
                deleted_files.append(image_path.name)
            except Exception as e:
                logger.error(f"Error deleting image at index {index}: {e}")
                errors.append(f"Index {index}: {str(e)}")

        # One rewrite for the whole batch — this is the entire speedup.
        if deleted_indices:
            embeddings.remove_images_from_embeddings(deleted_indices)

        response_data = {
            "success": len(deleted_indices) > 0 or len(errors) == 0,
            "deleted_count": len(deleted_indices),
            "deleted_indices": deleted_indices,
            "deleted_files": deleted_files,
        }
        if errors:
            response_data["errors"] = errors
            response_data["error_count"] = len(errors)

        return JSONResponse(content=response_data, status_code=200)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to delete images: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to delete images: {str(e)}") from e


@index_router.post(
    "/move_images/{album_key}",
    tags=["Index"],
    dependencies=[Depends(require_no_lock)],
)
async def move_images(
    album_key: str,
    req: MoveImagesRequest,
    album_config: AlbumDep,
    embeddings: EmbeddingsDep,
) -> JSONResponse:
    """Move multiple images to a different directory."""
    try:
        if album_config.source_type == "invokeai_board":
            # Moving files out of InvokeAI's outputs/images would leave its
            # database pointing at missing files.
            raise HTTPException(
                status_code=400,
                detail="Moving images is not supported for InvokeAI board albums",
            )

        target_dir = Path(req.target_directory)

        # Validate target directory exists and is writable
        if not target_dir.exists():
            raise HTTPException(status_code=400, detail="Target directory does not exist")
        if not target_dir.is_dir():
            raise HTTPException(status_code=400, detail="Target path is not a directory")
        if not os.access(target_dir, os.W_OK):
            raise HTTPException(status_code=403, detail="Target directory is not writable")

        moved_files = []
        errors = []
        same_folder_files = []

        for index in req.indices:
            try:
                image_path = embeddings.get_image_path(index)

                if not validate_image_access(album_config, image_path):
                    errors.append(f"Index {index}: Access denied")
                    continue

                if not image_path.exists() or not image_path.is_file():
                    errors.append(f"Index {index}: File not found")
                    continue

                # Check if already in target folder
                if image_path.parent.resolve() == target_dir.resolve():
                    same_folder_files.append(image_path.name)
                    continue

                target_path = target_dir / image_path.name

                # Check if target file exists
                if target_path.exists():
                    errors.append(f"{image_path.name}: File already exists in target directory")
                    continue

                # Move the file
                shutil.move(str(image_path), str(target_path))

                # Update embeddings with new path
                embeddings.update_image_path(index, target_path)

                moved_files.append(image_path.name)
                logger.info(f"Moved {image_path} to {target_path}")

            except Exception as e:
                logger.error(f"Error moving image at index {index}: {e}")
                errors.append(f"Index {index}: {str(e)}")

        # Build response
        # Operation is considered successful if:
        # - At least one file was moved, OR
        # - No errors occurred (files may already be in target folder)
        operation_successful = len(moved_files) > 0 or len(errors) == 0

        response_data = {
            "success": operation_successful,
            "moved_count": len(moved_files),
            "moved_files": moved_files,
        }

        if same_folder_files:
            response_data["same_folder_files"] = same_folder_files
            response_data["same_folder_count"] = len(same_folder_files)

        if errors:
            response_data["errors"] = errors
            response_data["error_count"] = len(errors)

        return JSONResponse(content=response_data, status_code=200)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to move images: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to move images: {str(e)}") from e


@index_router.post("/copy_images/{album_key}", tags=["Index"])
async def copy_images(
    album_key: str,
    req: CopyImagesRequest,
    album_config: AlbumDep,
    embeddings: EmbeddingsDep,
) -> JSONResponse:
    """Copy multiple images to a different directory."""
    # Note: No `require_no_lock` here — copying doesn't modify the album. The
    # per-album lock check inside ``AlbumDep`` still applies.
    try:
        target_dir = Path(req.target_directory)

        # Validate target directory exists and is writable
        if not target_dir.exists():
            raise HTTPException(status_code=400, detail="Target directory does not exist")
        if not target_dir.is_dir():
            raise HTTPException(status_code=400, detail="Target path is not a directory")
        if not os.access(target_dir, os.W_OK):
            raise HTTPException(status_code=403, detail="Target directory is not writable")

        copied_files = []
        errors = []

        for index in req.indices:
            try:
                image_path = embeddings.get_image_path(index)

                if not validate_image_access(album_config, image_path):
                    errors.append(f"Index {index}: Access denied")
                    continue

                if not image_path.exists() or not image_path.is_file():
                    errors.append(f"Index {index}: File not found")
                    continue

                target_path = target_dir / image_path.name

                # Check if target file exists
                if target_path.exists():
                    errors.append(f"{image_path.name}: File already exists in target directory")
                    continue

                # Copy the file (shutil.copy2 preserves metadata)
                shutil.copy2(str(image_path), str(target_path))

                copied_files.append(image_path.name)
                logger.info(f"Copied {image_path} to {target_path}")

            except Exception as e:
                logger.error(f"Error copying image at index {index}: {e}")
                errors.append(f"Index {index}: {str(e)}")

        # Build response
        # Operation is considered successful if at least one file was copied
        operation_successful = len(copied_files) > 0

        response_data = {
            "success": operation_successful,
            "copied_count": len(copied_files),
            "copied_files": copied_files,
        }

        if errors:
            response_data["errors"] = errors
            response_data["error_count"] = len(errors)

        return JSONResponse(content=response_data, status_code=200)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to copy images: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to copy images: {str(e)}") from e


class BoardAlbumFiles(NamedTuple):
    """What :func:`_resolve_board_album_files` found for a board album."""

    paths: list[Path]
    missing: int
    video_api_available: bool


async def _resolve_board_album_files(album_config) -> BoardAlbumFiles:
    """Resolve an InvokeAI-board album's images and videos to local paths.

    Fetches the selected boards' image names *and* video names from the
    InvokeAI API and maps them to ``<invokeai_root>/outputs/images/<name>``
    and ``<invokeai_root>/outputs/videos/<name>`` respectively — the two are
    separate resources on the InvokeAI side, listed by separate endpoints and
    stored in separate directories, so both have to be asked for by name.
    Names the API lists but that don't exist locally are skipped with a
    warning; if *none* of them exist the InvokeAI root is almost certainly
    wrong, which deserves a pointed error instead of a generic "no images
    found". The error names the directory that actually came up empty, since
    a board holding only videos would otherwise blame ``outputs`` as a whole.

    Returns the existing files, the count of listed-but-missing ones (so the
    caller can surface that discrepancy — the InvokeAI gallery will show a
    higher total than the album indexes), and whether the video listing could
    be obtained at all. That last flag is not cosmetic: an index update drops
    rows for every file the resolver did not return, so a video listing that
    failed rather than came back empty would silently prune videos that are
    still on the board.
    """
    outputs = Path(album_config.invokeai_root).expanduser() / "outputs"
    image_names = await invokeai_client.fetch_board_image_names(
        album_config.invokeai_url,
        album_config.invokeai_board_ids,
        album_config.invokeai_username,
        album_config.invokeai_password,
    )
    # ``api_available`` is False against an InvokeAI with no video API, so a
    # board album on an older backend keeps indexing exactly as it did before
    # — the caller only has to say so when it costs the album something.
    video_names, video_api_available = await invokeai_client.fetch_board_video_names(
        album_config.invokeai_url,
        album_config.invokeai_board_ids,
        album_config.invokeai_username,
        album_config.invokeai_password,
    )

    image_paths = [outputs / "images" / name for name in image_names]
    video_paths = [outputs / "videos" / name for name in video_names]
    paths = image_paths + video_paths
    existing = [p for p in paths if p.is_file()]
    missing = len(paths) - len(existing)
    if missing and not existing:
        if not video_paths:
            what, where = f"{len(paths)} board image(s)", outputs / "images"
        elif not image_paths:
            what, where = f"{len(paths)} board video(s)", outputs / "videos"
        else:
            what, where = f"{len(paths)} board image(s) and video(s)", outputs
        raise HTTPException(
            status_code=502,
            detail=(
                f"None of the {what} listed by InvokeAI were found under "
                f"{where} — check the InvokeAI root directory."
            ),
        )
    if missing:
        logger.warning(
            f"{missing} of {len(paths)} board files not found under {outputs}; skipping them."
        )
    return BoardAlbumFiles(existing, missing, video_api_available)


def _indexed_videos_dropped(index_path: Path, listed: list[Path]) -> int:
    """How many indexed video rows are absent from ``listed``.

    Counting *all* indexed videos would be wrong: a video listing can fail
    part-way (an unreadable board among several) and still return names, and
    the update only prunes rows for files the resolver did not return. The
    keys come from :meth:`Embeddings._path_compare_key` applied to the same
    paths the update itself will diff, so this count is exactly what that
    diff will drop.

    The .npz is read directly rather than through
    ``Embeddings.open_cached_embeddings``: this runs *before* the index is
    rewritten (and before an encoder-mismatch rebuild may unlink it), and
    that opener is an lru_cache keyed on the path alone, so priming it here
    would hand the pre-update contents to any later reader.
    """
    if not index_path.exists():
        return 0
    keep = {Embeddings._path_compare_key(p) for p in listed if is_video(p)}
    try:
        with np.load(index_path, allow_pickle=True) as data:
            filenames = [str(f) for f in data["filenames"]]
    except Exception as e:  # pragma: no cover - unreadable index
        logger.warning(f"Could not read {index_path} to count indexed videos: {e}")
        return 0
    return sum(
        1
        for name in filenames
        if is_video(Path(name))
        and Embeddings._path_compare_key(Path(name)) not in keep
    )


# Background Tasks
async def _update_index_background_async(album_key: str, album_config):
    """Background task for updating index with async support."""
    try:
        if getattr(album_config, "source_type", "directory") == "invokeai_board":
            progress_tracker.update_progress(
                album_key, 0, "Fetching board contents from InvokeAI..."
            )
            try:
                board_files = await _resolve_board_album_files(album_config)
            except HTTPException as e:
                progress_tracker.set_error(
                    album_key,
                    f"Could not fetch board contents from InvokeAI at "
                    f"{album_config.invokeai_url}: {e.detail}",
                )
                return
            image_paths, missing = board_files.paths, board_files.missing
            if not image_paths:
                # "No videos" is something we only know when the listing
                # answered. Saying it after an outage would state as fact the
                # very thing that could not be checked.
                progress_tracker.set_error(
                    album_key,
                    "Selected InvokeAI board(s) contain no images, and InvokeAI "
                    "did not answer the video listing, so any videos on them "
                    "could not be indexed."
                    if not board_files.video_api_available
                    else "Selected InvokeAI board(s) contain no images or videos",
                )
                return
            # Surface the gallery-vs-indexed discrepancy (always set so a clean
            # re-run clears any stale notice). Folded into the COMPLETED status
            # by progress_tracker.complete_operation.
            if missing:
                total = len(image_paths) + missing
                progress_tracker.set_completion_warning(
                    album_key,
                    f"{missing} of {total} file(s) listed by InvokeAI were not "
                    f"found on disk and were skipped.",
                )
            else:
                progress_tracker.set_completion_warning(album_key, None)
            # An unavailable video API is silent when the album has no videos
            # to lose (an InvokeAI predating video support, which is a
            # supported setup). When rows *are* about to be pruned for a
            # reason that has nothing to do with the board's contents, say so
            # — otherwise the run reports a clean success while the album
            # quietly shrinks.
            if not board_files.video_api_available:
                at_risk = _indexed_videos_dropped(
                    Path(album_config.index), board_files.paths
                )
                if at_risk:
                    progress_tracker.add_completion_warning(
                        album_key,
                        f"InvokeAI did not answer the video listing, so this "
                        f"album's videos could not be checked; {at_risk} "
                        f"previously indexed video(s) were dropped. They are "
                        f"restored by the next update that reaches the video "
                        f"API.",
                    )
        else:
            image_paths = [Path(path) for path in album_config.image_paths]
        index_path = Path(album_config.index)

        embeddings = Embeddings(
            embeddings_path=index_path,
            encoder_spec=album_config.encoder_spec,
            min_image_dimension=album_config.min_image_dimension,
            min_image_bytes=getattr(album_config, "min_image_bytes", 8192),
            album_key=album_key,
        )

        if index_path.exists():
            try:
                stored_spec = peek_encoder_spec(index_path)
            except Exception as e:
                logger.warning(
                    f"Could not read encoder spec from existing index {index_path}: {e}. "
                    f"Treating as fresh index."
                )
                stored_spec = None

            if stored_spec is not None and stored_spec != album_config.encoder_spec:
                logger.warning(
                    f"Encoder mismatch for album '{album_key}': existing index was built "
                    f"with {stored_spec!r} but album is now configured for "
                    f"{album_config.encoder_spec!r}. Deleting old index and rebuilding."
                )
                progress_tracker.start_operation(album_key, 0, "scanning")
                progress_tracker.update_progress(
                    album_key,
                    0,
                    f"Encoder changed ({stored_spec} → {album_config.encoder_spec}); rebuilding index from scratch",
                )
                index_path.unlink()
                logger.info(f"Creating new index for album '{album_key}'...")
                await embeddings.create_index_async(
                    image_paths, album_key, create_index=True
                )
            else:
                logger.info(f"Updating existing index for album '{album_key}'...")
                await embeddings.update_index_async(image_paths, album_key)
        else:
            logger.info(f"Creating new index for album '{album_key}'...")
            await embeddings.create_index_async(
                image_paths, album_key, create_index=True
            )

        # The "N files were skipped" notice is registered inside the indexing
        # calls above, not here: ``complete_operation`` runs before they
        # return, and it is what folds pending notices into the ProgressInfo
        # the poller reads. Anything added at this point is stranded.

        logger.info(f"Index update completed for album '{album_key}'")

    except IndexingCancelled as e:
        # User-requested cancellation isn't a failure — the inner layers
        # already called ``set_error`` with the friendly message; log at
        # info level so the background task summary doesn't look like a
        # crash.
        logger.info(f"Index update cancelled for album '{album_key}': {e}")
    except Exception as e:
        logger.error(f"Background index update failed for album '{album_key}': {e}")
        progress_tracker.set_error(album_key, str(e))
