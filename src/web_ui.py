import os
import sys
from fastapi import FastAPI, UploadFile, Form, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import re
import shutil
import tempfile
import base64
from pathlib import Path
from image_search import search_images, search_images_by_text

# Read from environment variables or use defaults
IMAGES_DIR = os.environ.get("IMAGES_DIR", "/net/cubox/CineRAID")
EMBEDDINGS_FILE = os.environ.get("EMBEDDINGS_FILE", "clip_image_embeddings.npz")

app = FastAPI(title="CLIP Image Search Web UI")
app.mount("/images", StaticFiles(directory=IMAGES_DIR), name="images")
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

@app.get("/", response_class=HTMLResponse)
async def form_get(request: Request):
    return templates.TemplateResponse("index.html", {"request": request, "results": None})

@app.post("/", response_class=HTMLResponse)
async def form_post(
    request: Request,
    file: UploadFile = None,
    text_query: str = Form(None),
    embeddings_file: str = Form(EMBEDDINGS_FILE),
    top_k: int = Form(20),
    cosine_cutoff: float = Form(0.25)  # Default cosine similarity cutoff
):
    image_tiles = []
    uploaded_image_url = None

    if text_query and text_query.strip():
        # Text search
        results, scores = search_images_by_text(text_query.strip(), embeddings_file, top_k)
        filtered = [
            (filename, score)
            for filename, score in zip(results, scores)
            if score >= cosine_cutoff
        ]
        image_tiles = [
            {"filename": f"{re.sub(IMAGES_DIR, '/images', filename)}",
             "score": f"{score:.4f}"}
            for filename, score in filtered
        ]
    elif file:
        # Image search (existing logic)
        with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as tmp:
            shutil.copyfileobj(file.file, tmp)
            tmp_path = Path(tmp.name)

        results, scores = search_images(tmp_path, embeddings_file, top_k)
        filtered = [
            (filename, score)
            for filename, score in zip(results, scores)
            if score >= cosine_cutoff
        ]
        image_tiles = [
            {"filename": f"{re.sub(IMAGES_DIR, '/images', filename)}",
             "score": f"{score:.4f}"}
            for filename, score in filtered
        ]
        with open(tmp_path, "rb") as f:
            uploaded_image_data = base64.b64encode(f.read()).decode("utf-8")
        uploaded_image_url = f"data:image/jpeg;base64,{uploaded_image_data}"
        tmp_path.unlink(missing_ok=True)

    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "results": image_tiles,
            "uploaded_image_url": uploaded_image_url,
            "top_k": top_k,
            "cosine_cutoff": cosine_cutoff,
            "text_query": text_query, 
        }
    )