import logging
import os
import random
import shutil
import uuid
from collections import Counter
from pathlib import Path
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from ..config import get_config_manager
from ..embeddings import _open_npz_file, get_fps_indices_global, get_kmeans_indices_global
from ..progress import IndexStatus, progress_tracker
from .index import check_album_lock

router = APIRouter()
logger = logging.getLogger(__name__)

# Store results for completed curation jobs
_curation_results: dict[str, Any] = {}

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
    filenames: list[str]
    output_folder: str

def _run_curation_task(job_id: str, request: CurationRequest):
    """
    Background task to run curation process with progress tracking.
    """
    try:
        # Start progress tracking
        progress_tracker.start_operation(job_id, request.iterations, "curating")

        config_manager = get_config_manager()
        album_config = config_manager.get_album(request.album)
        if not album_config:
            progress_tracker.set_error(job_id, "Album not found")
            return

        index_path = Path(album_config.index)
        logger.info(f"Curation Job {job_id}: Running {request.method.upper()} x{request.iterations}...")

        vote_counter = Counter()

        # Run Monte Carlo with progress updates
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

            # Update progress after each iteration
            progress_tracker.update_progress(
                job_id,
                i + 1,
                f"Iteration {i + 1}/{request.iterations}"
            )

        # Prepare Data needed for mapping
        data = _open_npz_file(index_path)
        filename_map = data["filename_map"]
        norm_map = {os.path.normpath(k).lower(): v for k, v in filename_map.items()}

        # Generate CSV Data (Analysis Results)
        analysis_results = []
        for filepath, count in vote_counter.most_common():
            f_norm = os.path.normpath(filepath).lower()
            if f_norm in norm_map:
                idx = int(norm_map[f_norm])

                if idx in request.excluded_indices:
                    continue

                subfolder = os.path.basename(os.path.dirname(filepath))

                analysis_results.append({
                    "filename": os.path.basename(filepath),
                    "subfolder": subfolder,
                    "filepath": filepath,
                    "index": idx,
                    "count": count,
                    "frequency": round((count / request.iterations) * 100, 1)
                })

        # Generate Selection (top N winners)
        consensus_files = [x['filepath'] for x in analysis_results[:request.target_count]]

        selected_indices = []
        final_file_list = []

        for f in consensus_files:
            f_norm = os.path.normpath(f).lower()
            if f_norm in norm_map:
                selected_indices.append(int(norm_map[f_norm]))
                final_file_list.append(f)

        result = {
            "status": "success",
            "count": len(selected_indices),
            "target_count": request.target_count,
            "selected_indices": selected_indices,
            "selected_files": final_file_list,
            "analysis_results": analysis_results
        }

        # Store result
        _curation_results[job_id] = result

        # Mark as completed
        progress_tracker.complete_operation(job_id, "Curation completed")
        logger.info(f"Curation Job {job_id}: Completed successfully")

    except Exception as e:
        logger.error(f"Curation Job {job_id}: Error - {str(e)}")
        progress_tracker.set_error(job_id, str(e))
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
        # Validate target_count parameter
        if request.target_count <= 0:
            raise HTTPException(status_code=400, detail="target_count must be positive")
        if request.target_count > 100000:
            raise HTTPException(status_code=400, detail="target_count exceeds reasonable limit")

        # Validate and cap iterations
        if request.iterations < 1:
            request.iterations = 1
        if request.iterations > 30:
            request.iterations = 30

        # Generate unique job ID
        job_id = f"curation_{uuid.uuid4().hex[:8]}"

        # Start background task
        background_tasks.add_task(_run_curation_task, job_id, request)

        return {
            "status": "started",
            "job_id": job_id,
            "iterations": request.iterations
        }

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
        if job_id in _curation_results:
            return {
                "status": "completed",
                "result": _curation_results[job_id]
            }
        raise HTTPException(status_code=404, detail="Job not found")

    if progress.status == IndexStatus.ERROR:
        return {
            "status": "error",
            "error": progress.error_message
        }

    if progress.status == IndexStatus.COMPLETED:
        # Return result if available
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
        # Validate target_count parameter
        if request.target_count <= 0:
            raise HTTPException(status_code=400, detail="target_count must be positive")
        if request.target_count > 100000:
            raise HTTPException(status_code=400, detail="target_count exceeds reasonable limit")

        # Validate and cap iterations
        if request.iterations < 1:
            request.iterations = 1
        if request.iterations > 30:
            request.iterations = 30

        config_manager = get_config_manager()
        album_config = config_manager.get_album(request.album)
        if not album_config:
            raise HTTPException(status_code=404, detail="Album not found")
        index_path = Path(album_config.index)

        logger.info(f"Curation: Running {request.method.upper()} x{request.iterations}...")

        vote_counter = Counter()

        # 1. Run Monte Carlo
        for _i in range(request.iterations):
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

        # 2. Prepare Data needed for mapping
        data = _open_npz_file(index_path)
        filename_map = data["filename_map"]
        norm_map = {os.path.normpath(k).lower(): v for k, v in filename_map.items()}

        # 3. Generate CSV Data (Analysis Results) - Includes EVERY image that got a vote
        analysis_results = []
        for filepath, count in vote_counter.most_common():
            f_norm = os.path.normpath(filepath).lower()
            if f_norm in norm_map:
                idx = int(norm_map[f_norm])

                # CRITICAL FIX: Strictly enforce exclusion.
                # Even if the algo returned it (e.g. due to index drift), we MUST drop it here.
                if idx in request.excluded_indices:
                    continue

                subfolder = os.path.basename(os.path.dirname(filepath))

                analysis_results.append({
                    "filename": os.path.basename(filepath),
                    "subfolder": subfolder,
                    "filepath": filepath,
                    "index": idx,
                    "count": count,
                    "frequency": round((count / request.iterations) * 100, 1)
                })

        # 4. Generate Selection (Green Dots) - Just the top N winners
        consensus_files = [x['filepath'] for x in analysis_results[:request.target_count]]

        selected_indices = []
        final_file_list = []

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
            "analysis_results": analysis_results
        }

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
    check_album_lock()  # May raise a 403 exception
    # Validate and sanitize the output folder to prevent path traversal
    if not request.output_folder:
        raise HTTPException(status_code=400, detail="Output folder required")

    try:
        requested_dir = Path(request.output_folder).expanduser()
        # Resolve the requested directory to an absolute path
        output_dir = requested_dir.resolve()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid output folder: {e}") from e

    # Define the base directory under which exports are allowed
    # Use user's home directory as the base to prevent system-wide access
    base_dir = Path.home().resolve()

    # Ensure the export directory is within the allowed base directory
    def is_within_base_dir(target_dir: Path, base: Path) -> bool:
        """Check if target directory is within the base directory."""
        if os.name == "nt":
            # On Windows, also ensure the drive matches
            return target_dir.drive.lower() == base.drive.lower() and (target_dir == base or base in target_dir.parents)
        else:
            return target_dir == base or base in target_dir.parents

    if not is_within_base_dir(output_dir, base_dir):
        raise HTTPException(status_code=400, detail="Output folder is outside the allowed export directory")

    if not output_dir.exists():
        try:
            output_dir.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            raise HTTPException(status_code=400, detail=f"Create folder failed: {e}") from e

    success_count = 0
    errors = []

    for img_path in request.filenames:
        try:
            if not os.path.exists(img_path):
                continue

            original_filename = os.path.basename(img_path)
            parent_folder = os.path.basename(os.path.dirname(img_path))
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

            shutil.copy2(img_path, dest_path)

            base_src = os.path.splitext(img_path)[0]
            base_dest = os.path.splitext(str(dest_path))[0]
            for ext in ['.txt', '.caption', '.json']:
                txt_src = base_src + ext
                if os.path.exists(txt_src):
                    shutil.copy2(txt_src, base_dest + ext)
            success_count += 1
        except Exception as e:
            errors.append(f"Copy failed: {e}")

    return {"status": "success", "exported": success_count, "errors": errors}
