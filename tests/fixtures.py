"""
Fixtures for pytest
"""

import os
import shutil
import time
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

    # Return the album data (or fetch from API if you want the server's version)
    yield album_data
    # teardown
    client.delete(f"/delete_album/{album_data['key']}")


def poll_during_indexing(client, album_key, timeout=60):
    """Poll the index progress until it completes or times out."""
    start_time = time.time()
    while True:
        response = client.get(f"/index_progress/{album_key}")
        assert response.status_code == 200
        progress = response.json()
        if progress["status"] == "completed":
            break
        if progress["status"] == "error":
            raise Exception(
                f"Indexing failed: {progress.get('error_message', 'Unknown error')}"
            )
        if time.time() - start_time > timeout:
            raise TimeoutError("Indexing did not complete within the timeout period.")
        time.sleep(1)  # Wait before polling again


def build_index(client, new_album, monkeypatch):
    """Helper function to build the index for the album."""
    from clipslide.backend.embeddings import Embeddings

    monkeypatch.setattr(
        Embeddings, "minimum_image_size", 10 * 1024
    )  # Set minimum image size to 10K for testing

    response = client.post(f"/update_index_async", json={"album_key": new_album["key"]})
    assert response.status_code == 202
    task_id = response.json().get("task_id")
    assert task_id is not None
    try:
        poll_during_indexing(client, new_album["key"])
    except TimeoutError as e:
        pytest.fail(f"Indexing did not complete: {str(e)}")


def fetch_filename(client, album_key, index) -> str:
    """Helper function to fetch the filename from the album."""
    response = client.get(f"/retrieve_image/{album_key}/{index}")
    assert response.status_code == 200
    return response.json().get("filename", "")


def count_test_images():
    """Count the number of test images in the fixtures directory."""
    src_images = Path(__file__).parent / "test_images"
    return len([img for img in src_images.iterdir() if img.is_file()])
