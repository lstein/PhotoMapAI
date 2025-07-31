"""
Fixtures for pytest
"""

import os
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from clipslide.backend.config import Album, create_album


@pytest.fixture
def client():
    """Fixture to create a test client for the Clipslide application."""
    from clipslide.backend.clipslide_server import app

    return TestClient(app)


@pytest.fixture
def new_album(client, tmp_path) -> dict:
    """Create a temp album from images in a temporary directory; return the album info"""
    # Path to your source test images
    src_images = Path(__file__).parent / "test_images"
    # Path to the temp directory for this test
    temp_img_dir = tmp_path / "images"
    temp_img_dir.mkdir(parents=True, exist_ok=True)

    # Copy all test images to the temp directory
    for img in src_images.iterdir():
        if img.is_file():
            shutil.copy(img, temp_img_dir / img.name)

    album_data = {
        "key": "test_album",
        "name": "Test Album",
        "image_paths": [temp_img_dir.as_posix()],
        "index": (temp_img_dir / "embeddings.npz").as_posix(),
        "umap_eps": 0.1,
        "description": "A test album",
    }
    response = client.post("/add_album/", json=album_data)
    assert response.status_code == 201

    # debugging
    response = client.get("/available_albums")
    assert response.status_code == 200
    albums = response.json()
    # Return the album data (or fetch from API if you want the server's version)
    return album_data
