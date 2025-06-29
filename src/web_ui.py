from fastapi import FastAPI, UploadFile, Form, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import re
import shutil
import tempfile
import base64
from pathlib import Path
from image_search import search_images

app = FastAPI(title="CLIP Image Search Web UI")
app.mount("/images", StaticFiles(directory="/net/cubox/CineRAID"), name="images")
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

@app.get("/", response_class=HTMLResponse)
async def form_get(request: Request):
    return templates.TemplateResponse("index.html", {"request": request, "results": None})

@app.post("/", response_class=HTMLResponse)
async def form_post(
    request: Request,
    file: UploadFile,
    embeddings_file: str = Form("clip_image_embeddings.npz"),
    top_k: int = Form(9),
    cosine_cutoff: float = Form(0.0)
):
    # Save uploaded file to a temporary location
    with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = Path(tmp.name)

    # Call the search_images function
    results, scores = search_images(tmp_path, embeddings_file, top_k)

    # Apply cosine similarity cutoff
    filtered = [
        (filename, score)
        for filename, score in zip(results, scores)
        if score >= cosine_cutoff
    ]
    # If not enough results after cutoff, pad with top results
    # if len(filtered) < top_k:
    #     filtered = list(zip(results, scores))[:top_k]

    image_tiles = [
        {"filename": f"{re.sub('/net/cubox/CineRAID', '/images', filename)}",
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
        }
    )