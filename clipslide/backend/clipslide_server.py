# slideshow_server.py
import logging
import os
import numpy as np
from pathlib import Path
from fastapi import (
    FastAPI,
    Request,
)
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .constants import DEFAULT_ALBUM, DEFAULT_DELAY, DEFAULT_MODE, get_package_resource_path
from .config import get_config_manager
from .routers.umap import umap_router
from .routers.album import album_router
from .routers.search import search_router
from .routers.index import index_router

# Initialize logging
logger = logging.getLogger(__name__)

# Initialize configuration manager
config_manager = get_config_manager()

# Initialize FastAPI app
app = FastAPI(title="Slideshow")

# Include routers
for router in [umap_router, search_router, index_router, album_router]:
    app.include_router(router)

# Mount static files and templates
static_path = get_package_resource_path("static")
app.mount("/static", StaticFiles(directory=static_path), name="static")

templates_path = get_package_resource_path("templates")
templates = Jinja2Templates(directory=templates_path)

# Main Routes
@app.get("/", response_class=HTMLResponse, tags=["Main"])
async def get_root(
    request: Request,
    album: str = DEFAULT_ALBUM,
    delay: int = DEFAULT_DELAY,
    mode: str = DEFAULT_MODE,
):
    """Serve the main slideshow page."""
    albums = config_manager.get_albums()
    if not albums:
        album  = None
    elif album not in albums:
        album = list(albums.keys())[0]

    return templates.TemplateResponse(
        request,
        "slideshow.html",
        {
            "album": album,
            "delay": delay,
            "mode": mode
        },
    )


# Main Entry Point
def main():
    """Main entry point for the slideshow server."""
    import uvicorn

    repo_root = Path(get_package_resource_path("clipslide"),'../..').resolve()
    print(f"Starting Clipslide server with backend root: {repo_root}")

    uvicorn.run(
        "clipslide.backend.clipslide_server:app",
        host="0.0.0.0",
        port=8050,
        reload=True,
        reload_dirs=[repo_root],
    )


if __name__ == "__main__":
    main()
