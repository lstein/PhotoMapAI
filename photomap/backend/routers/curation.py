import logging
import os
import random
import shutil
import threading
import uuid
from collections import Counter
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from ..config import get_config_manager
from ..embeddings import _open_npz_file, get_fps_indices_global, get_kmeans_indices_global
from ..progress import IndexStatus, progress_tracker
from .album import validate_album_exists, validate_image_access

router = APIRouter()
logger = logging.getLogger(__name__)

# Store results for completed curation jobs. The background task writes here
# from a worker thread while request handlers read in the event-loop thread,
# so guard accesses with a lock to keep the dict from being mutated mid-read.
_curation_results: dict[str, Any] = {}
_curation_results_lock = threading.Lock()

class CurationRequest(BaseModel):
    """
    Request model for the curation endpoint.
    """
    target_count: int
    iterations: int = 1
    album: str
    method: str = "fps"
    excluded_indices: list[int] = []

class ExportRequest(BaseModel):
    """
    Request model for the export endpoint.
    """
    album: str
    filenames: list[str]
    output_folder: str

def _validate_curation_request(request: CurationRequest) -> None:
    """Clamp / reject obviously bad inputs. Shared by the async and sync endpoints."""
    if request.target_count <= 0:
        raise HTTPException(status_code=400, detail="target_count must be positive")
    if request.target_count > 100000:
        raise HTTPException(status_code=400, detail="target_count exceeds reasonable limit")
    if request.iterations < 1:
        request.iterations = 1
    if request.iterations > 30:
        request.iterations = 30


def _compute_curation(
    request: CurationRequest,
    on_iteration: Callable[[int], None] | None = None,
) -> dict[str, Any]:
    """Run the Monte Carlo curation and build the structured response dict.

    ``on_iteration(i)`` (1-indexed) fires after each Monte Carlo iteration so
    the async endpoint can advance its ProgressTracker; the sync endpoint
    passes ``None`` and just runs to completion.

    Raises ``LookupError`` if the album key doesn't resolve — callers decide
    whether that surfaces as a 404 (sync endpoint) or a ProgressTracker error
    (background task).
    """
    config_manager = get_config_manager()
    album_config = config_manager.get_album(request.album)
    if not album_config:
        raise LookupError("Album not found")

    index_path = Path(album_config.index)
    vote_counter: Counter = Counter()

    for i in range(request.iterations):
        run_seed = random.randint(0, 1000000)
        if request.method == "kmeans":
            selected_files = get_kmeans_indices_global(
                index_path, request.target_count, run_seed, request.excluded_indices
            )
        else:
            selected_files = get_fps_indices_global(
                index_path, request.target_count, run_seed, request.excluded_indices
            )
        vote_counter.update(selected_files)
        if on_iteration is not None:
            on_iteration(i + 1)

    data = _open_npz_file(index_path)
    filename_map = data["filename_map"]
    norm_map = {os.path.normpath(k).lower(): v for k, v in filename_map.items()}

    # Every image that received a vote goes into the analysis table; the
    # exclusion check defends against algorithms that returned an excluded
    # index (e.g. from index drift after a recent re-index).
    analysis_results = []
    for filepath, count in vote_counter.most_common():
        f_norm = os.path.normpath(filepath).lower()
        if f_norm in norm_map:
            idx = int(norm_map[f_norm])
            if idx in request.excluded_indices:
                continue

            analysis_results.append({
                "filename": os.path.basename(filepath),
                "subfolder": os.path.basename(os.path.dirname(filepath)),
                "filepath": filepath,
                "index": idx,
                "count": count,
                "frequency": round((count / request.iterations) * 100, 1),
            })

    # Top-N consensus winners.
    consensus_files = [x["filepath"] for x in analysis_results[: request.target_count]]
    selected_indices: list[int] = []
    final_file_list: list[str] = []
    for f in consensus_files:
        f_norm = os.path.normpath(f).lower()
        if f_norm in norm_map:
            selected_indices.append(int(norm_map[f_norm]))
            final_file_list.append(f)

    return {
        "status": "success",
        "count": len(selected_indices),
        "target_count": request.target_count,
        "selected_indices": selected_indices,
        "selected_files": final_file_list,
        "analysis_results": analysis_results,
    }


def _run_curation_task(job_id: str, request: CurationRequest):
    """
    Background task to run curation process with progress tracking.
    """
    try:
        progress_tracker.start_operation(job_id, request.iterations, "curating")
        logger.info(f"Curation Job {job_id}: Running {request.method.upper()} x{request.iterations}...")

        def _on_iter(i: int) -> None:
            progress_tracker.update_progress(
                job_id, i, f"Iteration {i}/{request.iterations}"
            )

        try:
            result = _compute_curation(request, on_iteration=_on_iter)
        except LookupError as exc:
            progress_tracker.set_error(job_id, str(exc))
            return

        with _curation_results_lock:
            _curation_results[job_id] = result

        progress_tracker.complete_operation(job_id, "Curation completed")
        logger.info(f"Curation Job {job_id}: Completed successfully")

    except Exception as e:
        logger.error(f"Curation Job {job_id}: Error - {str(e)}")
        progress_tracker.set_error(job_id, str(e))
        with _curation_results_lock:
            _curation_results[job_id] = {
                "status": "error",
                "error": str(e)
            }

@router.post("/curate")
async def run_curation(request: CurationRequest, background_tasks: BackgroundTasks):
    """
    Start an async curation process (Monte Carlo FPS or K-Means).
    Returns a job_id that can be used to poll for progress and results.
    """
    try:
        _validate_curation_request(request)

        # Generate unique job ID
        job_id = f"curation_{uuid.uuid4().hex[:8]}"

        # Start background task
        background_tasks.add_task(_run_curation_task, job_id, request)

        return {
            "status": "started",
            "job_id": job_id,
            "iterations": request.iterations
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to start curation: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e)) from e

@router.get("/curate/progress/{job_id}")
async def get_curation_progress(job_id: str):
    """
    Poll for curation progress.
    """
    progress = progress_tracker.get_progress(job_id)

    if progress is None:
        # Check if we have a completed result
        with _curation_results_lock:
            cached = _curation_results.get(job_id)
        if cached is not None:
            return {
                "status": "completed",
                "result": cached
            }
        raise HTTPException(status_code=404, detail="Job not found")

    if progress.status == IndexStatus.ERROR:
        return {
            "status": "error",
            "error": progress.error_message
        }

    if progress.status == IndexStatus.COMPLETED:
        # Return result if available
        with _curation_results_lock:
            result = _curation_results.get(job_id, {})
        return {
            "status": "completed",
            "result": result
        }

    # Still running
    return {
        "status": "running",
        "progress": {
            "current": progress.images_processed,
            "total": progress.total_images,
            "percentage": progress.progress_percentage,
            "step": progress.current_step
        }
    }

@router.post("/curate_sync")
async def run_curation_sync(request: CurationRequest):
    """
    Run the curation process synchronously (for backwards compatibility).
    This is the original synchronous version.

    Args:
        request: CurationRequest containing target count, iterations, album, method, etc.

    Returns:
        JSON response with status, selected indices, files, and analysis results.
    """
    try:
        _validate_curation_request(request)
        logger.info(f"Curation: Running {request.method.upper()} x{request.iterations}...")
        return _compute_curation(request)

    except HTTPException:
        raise
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except Exception as e:
        logger.error(f"Curation Error: {e}")
        raise HTTPException(status_code=500, detail=str(e)) from e

@router.post("/export")
async def export_dataset(request: ExportRequest):
    """
    Export the selected images to a specified folder.

    Args:
        request: ExportRequest containing filenames and output folder.

    Returns:
        JSON response with success count and any errors.
    """
    # Export is not a destructive album-management operation; the per-album
    # lock check is already handled inside validate_album_exists() below.
    if not request.output_folder:
        raise HTTPException(status_code=400, detail="Output folder required")

    try:
        requested_dir = Path(request.output_folder).expanduser()
        # Resolve the requested directory to an absolute path
        output_dir = requested_dir.resolve()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid output folder: {e}") from e

    # Resolve the album so we can verify each source path lives inside it —
    # otherwise a caller could ask us to copy /etc/passwd into their export
    # dir. Source-path security is handled by validate_image_access(); no
    # home-dir restriction is placed on the destination so users can export
    # to external drives, network mounts, etc.
    album_config = validate_album_exists(request.album)

    if not output_dir.exists():
        try:
            output_dir.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            raise HTTPException(status_code=400, detail=f"Create folder failed: {e}") from e

    success_count = 0
    errors = []

    for img_path in request.filenames:
        try:
            src_path = Path(img_path)
            if not src_path.exists():
                continue

            # Reject any source that doesn't live inside one of the album's
            # configured image_paths. ``validate_image_access`` resolves both
            # sides and uses ``is_relative_to``, which blocks ``..``-style
            # escapes; the explicit ``is_symlink`` guard blocks a symlink
            # planted inside the album from pointing at an arbitrary file.
            if src_path.is_symlink() or not validate_image_access(album_config, src_path):
                errors.append(f"Access denied: {img_path}")
                continue

            original_filename = src_path.name
            parent_folder = src_path.parent.name
            name_stem, name_ext = os.path.splitext(original_filename)

            candidate_name = original_filename
            dest_path = output_dir / candidate_name

            if dest_path.exists():
                candidate_name = f"{parent_folder}_{original_filename}"
                dest_path = output_dir / candidate_name

            counter = 1
            while dest_path.exists():
                candidate_name = f"{parent_folder}_{name_stem}_{counter}{name_ext}"
                dest_path = output_dir / candidate_name
                counter += 1

            shutil.copy2(src_path, dest_path)

            base_src = src_path.with_suffix("")
            base_dest = dest_path.with_suffix("")
            for ext in ['.txt', '.caption', '.json']:
                sidecar_src = base_src.with_name(base_src.name + ext)
                if sidecar_src.exists() and not sidecar_src.is_symlink():
                    shutil.copy2(sidecar_src, base_dest.with_name(base_dest.name + ext))
            success_count += 1
        except Exception as e:
            errors.append(f"Copy failed: {e}")

    return {"status": "success", "exported": success_count, "errors": errors}
