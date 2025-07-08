from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import JSONResponse
from pathlib import Path
import shutil
import tempfile
from backend.embeddings import Embeddings

app = FastAPI(title="CLIP Image Search API")


@app.post("/search_with_image/")
async def do_embedding_search_by_image(
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
    embeddings = Embeddings(embeddings_path=Path(embeddings_file))
    results, scores = embeddings.search_images_by_similarity(tmp_path, top_k=top_k)

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
async def do_embedding_search_by_text(
    text_query: str = Form(...),
    embeddings_file: str = Form("clip_image_embeddings.npz"),
    top_k: int = Form(20),
):
    """Search for images semantically matching the query."""
    # Call the search_images function
    embeddings = Embeddings(embeddings_path=Path(embeddings_file))
    results, scores = embeddings.search_images_by_text(text_query, top_k=top_k)

    # Return results as JSON
    return JSONResponse(
        content={
            "results": [
                {"filename": str(filename), "score": float(score)}
                for filename, score in zip(results, scores)
            ]
        }
    )
