"""
test_album_lock.py
Tests for the album lock functionality of the PhotoMap application.
When album-locked is set, various file management API routes should be disabled.
"""

import os
import pytest
from fixtures import client
from photomap.backend.config import create_album


@pytest.fixture
def setup_album_lock():
    """Setup and teardown for album lock tests."""
    # Save original state
    original_album_locked = os.environ.get("PHOTOMAP_ALBUM_LOCKED")
    
    # Set album lock
    os.environ["PHOTOMAP_ALBUM_LOCKED"] = "test_album"
    
    yield
    
    # Restore original state
    if original_album_locked:
        os.environ["PHOTOMAP_ALBUM_LOCKED"] = original_album_locked
    else:
        os.environ.pop("PHOTOMAP_ALBUM_LOCKED", None)


def test_add_album_locked(client, setup_album_lock):
    """Test that /add_album is disabled when album is locked."""
    new_album = create_album(
        "new_album",
        "New Album",
        image_paths=["./tests/test_images"],
        index="./tests/test_images/embeddings.npz",
        umap_eps=0.1,
    )
    response = client.post("/add_album", json=new_album.model_dump())
    assert response.status_code == 403
    assert "Album management is locked" in response.json()["detail"]


def test_update_album_locked(client, setup_album_lock):
    """Test that /update_album is disabled when album is locked."""
    album_data = {
        "key": "test_album",
        "name": "Test Album",
        "image_paths": ["./tests/test_images"],
        "index": "./tests/test_images/embeddings.npz",
        "umap_eps": 0.1,
        "description": "Updated album"
    }
    response = client.post("/update_album", json=album_data)
    assert response.status_code == 403
    assert "Album management is locked" in response.json()["detail"]


def test_delete_album_locked(client, setup_album_lock):
    """Test that /delete_album is disabled when album is locked."""
    response = client.delete("/delete_album/test_album")
    assert response.status_code == 403
    assert "Album management is locked" in response.json()["detail"]


def test_filetree_home_locked(client, setup_album_lock):
    """Test that /filetree/home is disabled when album is locked."""
    response = client.get("/filetree/home")
    assert response.status_code == 403
    assert "Album management is locked" in response.json()["detail"]


def test_filetree_directories_locked(client, setup_album_lock):
    """Test that /filetree/directories is disabled when album is locked."""
    response = client.get("/filetree/directories")
    assert response.status_code == 403
    assert "Album management is locked" in response.json()["detail"]


def test_filetree_create_directory_locked(client, setup_album_lock):
    """Test that /filetree/create_directory is disabled when album is locked."""
    response = client.post("/filetree/create_directory", json={
        "parent_path": "/tmp",
        "directory_name": "test_dir"
    })
    assert response.status_code == 403
    assert "Album management is locked" in response.json()["detail"]


def test_curation_export_locked(client, setup_album_lock):
    """Test that /api/curation/export is disabled when album is locked."""
    response = client.post("/api/curation/export", json={
        "filenames": ["test.jpg"],
        "output_folder": "/tmp/export"
    })
    assert response.status_code == 403
    assert "Album management is locked" in response.json()["detail"]


def test_routes_work_without_lock(client):
    """Test that routes work normally when album is not locked."""
    # Ensure no album lock is set
    os.environ.pop("PHOTOMAP_ALBUM_LOCKED", None)
    
    # Test that /filetree/home works
    response = client.get("/filetree/home")
    assert response.status_code == 200
    assert "homePath" in response.json()
    
    # Test that /filetree/directories works
    response = client.get("/filetree/directories")
    # Should return 200 or 404 depending on path, but not 403
    assert response.status_code != 403
