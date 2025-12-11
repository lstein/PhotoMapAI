import os
import shutil
import logging
import random
from collections import Counter
from typing import List
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..embeddings import get_fps_indices_global, get_kmeans_indices_global, _open_npz_file
from ..config import get_config_manager

router = APIRouter()
logger = logging.getLogger(__name__)

class CurationRequest(BaseModel):
    target_count: int
    iterations: int = 1
    album: str
    method: str = "fps"
    excluded_indices: List[int] = []

class ExportRequest(BaseModel):
    filenames: List[str]
    output_folder: str

@router.post("/curate")
async def run_curation(request: CurationRequest):
    try:
        config_manager = get_config_manager()
        album_config = config_manager.get_album(request.album)
        if not album_config: raise HTTPException(status_code=404, detail="Album not found")
        index_path = Path(album_config.index)
        
        if request.iterations < 1: request.iterations = 1
        if request.iterations > 30: request.iterations = 30

        logger.info(f"Curation: Running {request.method.upper()} x{request.iterations}...")

        vote_counter = Counter()

        # 1. Run Monte Carlo
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
            "selected_indices": selected_indices,
            "selected_files": final_file_list,
            "analysis_results": analysis_results # <--- PASSED BACK FOR CSV
        }

    except Exception as e:
        logger.error(f"Curation Error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/export")
async def export_dataset(request: ExportRequest):
    # (Keep the existing export function I gave you previously with the renaming logic)
    output_dir = request.output_folder
    if not output_dir: raise HTTPException(status_code=400, detail="Output folder required")
    if not os.path.exists(output_dir):
        try: os.makedirs(output_dir)
        except OSError as e: raise HTTPException(status_code=400, detail=f"Create folder failed: {e}")

    success_count = 0
    errors = []

    for img_path in request.filenames:
        try:
            if not os.path.exists(img_path): continue
            
            original_filename = os.path.basename(img_path)
            parent_folder = os.path.basename(os.path.dirname(img_path))
            name_stem, name_ext = os.path.splitext(original_filename)

            candidate_name = original_filename
            dest_path = os.path.join(output_dir, candidate_name)

            if os.path.exists(dest_path):
                candidate_name = f"{parent_folder}_{original_filename}"
                dest_path = os.path.join(output_dir, candidate_name)

            counter = 1
            while os.path.exists(dest_path):
                candidate_name = f"{parent_folder}_{name_stem}_{counter}{name_ext}"
                dest_path = os.path.join(output_dir, candidate_name)
                counter += 1

            shutil.copy2(img_path, dest_path)
            
            base_src = os.path.splitext(img_path)[0]
            base_dest = os.path.splitext(dest_path)[0]
            for ext in ['.txt', '.caption', '.json']:
                txt_src = base_src + ext
                if os.path.exists(txt_src):
                    shutil.copy2(txt_src, base_dest + ext)
            success_count += 1
        except Exception as e:
            errors.append(f"Copy failed: {e}")

    return {"status": "success", "exported": success_count, "errors": errors}