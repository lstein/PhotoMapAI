from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import JSONResponse
from pathlib import Path
import shutil
import tempfile
from backend.image_search import search_images, search_images_by_text

app = FastAPI(title="CLIP Image Search API")


@app.post("/search_with_image/")
async def search(
    file: UploadFile = File(...),
    embeddings_file: str = Form("clip_image_embeddings.npz"),
    top_k: int = Form(20),
):
    """Search for similar images using a query image."""
    # Save uploaded file to a temporary location
    with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = Path(tmp.name)

    # Call the search_images function
    results, scores = search_images(tmp_path, embeddings_file, top_k)

    # Clean up temp file
    tmp_path.unlink(missing_ok=True)

    # Return results as JSON
    return JSONResponse(
        content={
            "results": [
                {"filename": str(filename), "score": float(score)}
                for filename, score in zip(results, scores)
            ]
        }
    )


@app.post("/search_with_text/")
async def search(
    text_query: str = Form(...),
    embeddings_file: str = Form("clip_image_embeddings.npz"),
    top_k: int = Form(20),
):
    """Search for images semantically matching the query."""
    # Call the search_images function
    results, scores = search_images_by_text(text_query, embeddings_file, top_k)

    # Return results as JSON
    return JSONResponse(
        content={
            "results": [
                {"filename": str(filename), "score": float(score)}
                for filename, score in zip(results, scores)
            ]
        }
    )
