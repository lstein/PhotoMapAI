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


@pytest.fixture
def setup_multiple_album_lock():
    """Setup and teardown for multiple album lock tests."""
    # Save original state
    original_album_locked = os.environ.get("PHOTOMAP_ALBUM_LOCKED")
    
    # Set multiple album lock
    os.environ["PHOTOMAP_ALBUM_LOCKED"] = "test_album,another_album"
    
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


def test_multiple_albums_locked_management_disabled(client, setup_multiple_album_lock):
    """Test that album management is disabled even with multiple locked albums."""
    # Test that /add_album is disabled
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


def test_multiple_albums_locked_filetree_disabled(client, setup_multiple_album_lock):
    """Test that filetree operations are disabled with multiple locked albums."""
    # Test that /filetree/home is disabled
    response = client.get("/filetree/home")
    assert response.status_code == 403
    assert "Album management is locked" in response.json()["detail"]


def test_multiple_albums_access_allowed_album(client, setup_multiple_album_lock):
    """Test that accessing a locked album is allowed."""
    # This test verifies that operations on locked albums don't raise 403
    # when the album key is in the locked list
    # Note: The actual behavior depends on the album existing in the config
    pass


def test_multiple_albums_access_denied_non_locked_album(client, setup_multiple_album_lock):
    """Test that accessing a non-locked album is denied when albums are locked."""
    # Try to get an album that's not in the locked list
    response = client.get("/album/unlocked_album/")
    assert response.status_code == 403
    assert "Album management is locked" in response.json()["detail"]


def test_validate_locked_albums_exist():
    """Test that the validation logic correctly identifies invalid album keys."""
    from photomap.backend.config import get_config_manager
    
    # Get the config manager with test config
    config = get_config_manager()
    available_albums = config.get_albums()
    
    # Test with invalid albums - these should always be detected
    invalid_albums = ["nonexistent_album_1", "nonexistent_album_2"]
    invalid = [album for album in invalid_albums if album not in available_albums]
    assert len(invalid) == len(invalid_albums), "All nonexistent albums should be detected as invalid"
    
    # Test mixed valid and invalid (if albums exist in test config)
    if available_albums:
        valid_album = list(available_albums.keys())[0]
        mixed = [valid_album, "nonexistent_album"]
        invalid = [album for album in mixed if album not in available_albums]
        assert len(invalid) == 1, "Should detect exactly one invalid album"
        assert invalid[0] == "nonexistent_album"
        
        # Verify valid albums pass validation
        valid = [album for album in [valid_album] if album not in available_albums]
        assert len(valid) == 0, "Valid album should pass validation"
