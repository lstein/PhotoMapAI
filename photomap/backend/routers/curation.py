import os
import shutil
import logging
from typing import List
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..embeddings import get_fps_indices_global, get_kmeans_indices_global, _open_npz_file
from ..config import get_config_manager

router = APIRouter()
logger = logging.getLogger(__name__)

class FPSRequest(BaseModel):
    target_count: int
    seed: int = 42
    album: str
    method: str = "fps"

class ExportRequest(BaseModel):
    filenames: List[str]
    output_folder: str

@router.post("/fps")
async def get_fps_selection(request: FPSRequest):
    try:
        # ... (Validation code is same as before) ...
        config_manager = get_config_manager()
        album_config = config_manager.get_album(request.album)
        if not album_config: raise HTTPException(status_code=404, detail="Album not found")
        index_path = Path(album_config.index)
        if not index_path.exists(): raise HTTPException(status_code=404, detail="Index missing")

        # --- SWITCH ALGORITHM BASED ON METHOD ---
        if request.method == "kmeans":
            selected_files = get_kmeans_indices_global(
                embeddings_path=index_path, 
                n_target=request.target_count, 
                seed=request.seed
            )
        else:
            # Default to FPS
            selected_files = get_fps_indices_global(
                embeddings_path=index_path, 
                n_target=request.target_count, 
                seed=request.seed
            )
        # ----------------------------------------

        # ... (The mapping logic / return remains exactly the same) ...
        data = _open_npz_file(index_path)
        filename_map = data["filename_map"]
        norm_map = {os.path.normpath(k).lower(): v for k, v in filename_map.items()}
        selected_indices = []
        final_file_list = []
        for f in selected_files:
            f_norm = os.path.normpath(f).lower()
            if f_norm in norm_map:
                selected_indices.append(int(norm_map[f_norm]))
                final_file_list.append(f)
        
        return {
            "status": "success", 
            "count": len(selected_indices), 
            "selected_indices": selected_indices,
            "selected_files": final_file_list
        }
    except Exception as e:
        logger.error(f"Selection Error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/export")
async def export_dataset(request: ExportRequest):
    output_dir = request.output_folder
    
    if not output_dir:
        raise HTTPException(status_code=400, detail="Output folder is required")

    if not os.path.exists(output_dir):
        try:
            os.makedirs(output_dir)
        except OSError as e:
            raise HTTPException(status_code=400, detail=f"Could not create output folder: {e}")

    success_count = 0
    errors = []

    for img_path in request.filenames:
        try:
            if not os.path.exists(img_path):
                continue
            
            # --- INTELLIGENT RENAMING LOGIC ---
            
            original_filename = os.path.basename(img_path)       # 0001.png
            parent_folder = os.path.basename(os.path.dirname(img_path)) # apple
            name_stem, name_ext = os.path.splitext(original_filename)   # 0001, .png

            # Strategy 1: Try exact filename (0001.png)
            candidate_name = original_filename
            dest_path = os.path.join(output_dir, candidate_name)

            if os.path.exists(dest_path):
                # Strategy 2: Try Prepending Folder Name (apple_0001.png)
                # This solves the "apple/0001 vs orange/0001" issue neatly
                candidate_name = f"{parent_folder}_{original_filename}"
                dest_path = os.path.join(output_dir, candidate_name)

            # Strategy 3: Fallback to Counter (apple_0001_1.png)
            # Only used if Strategy 2 still has a conflict (rare)
            counter = 1
            while os.path.exists(dest_path):
                candidate_name = f"{parent_folder}_{name_stem}_{counter}{name_ext}"
                dest_path = os.path.join(output_dir, candidate_name)
                counter += 1

            # 1. Copy Image to new unique name
            shutil.copy2(img_path, dest_path)
            
            # 2. Copy & Rename Matching Text Files
            # We want: apple_0001.png -> apple_0001.txt (matching the new image name)
            
            base_src = os.path.splitext(img_path)[0]     # /path/to/apple/0001
            base_dest = os.path.splitext(dest_path)[0]   # /output/apple_0001
            
            for ext in ['.txt', '.caption', '.json']:
                txt_src = base_src + ext
                if os.path.exists(txt_src):
                    # Copy to new destination with new name
                    shutil.copy2(txt_src, base_dest + ext)
            
            success_count += 1
        except Exception as e:
            errors.append(f"Failed to copy {os.path.basename(img_path)}: {e}")

    return {
        "status": "success",
        "exported": success_count,
        "errors": errors if errors else None
    }