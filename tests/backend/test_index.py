from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from fixtures import build_index, client, count_test_images, fetch_filename, new_album

# Import the cache function directly so we can inspect it
from photomap.backend.embeddings import _open_npz_file

TEST_IMAGE_COUNT = count_test_images()


def test_index_creation(
    client: TestClient, new_album: dict, monkeypatch: pytest.MonkeyPatch
):
    """Test the ability to create indexes."""
    build_index(client, new_album, monkeypatch)
    # Check that the index exists
    response = client.get(f"/index_exists/{new_album['key']}")
    assert response.status_code == 200
    exists = response.json().get("exists")
    assert exists is True

    # Check that we can get metadata for the index
    response = client.get(f"/index_metadata/{new_album['key']}")
    assert response.status_code == 200
    metadata = response.json()
    assert (
        metadata["filename_count"] == TEST_IMAGE_COUNT
    )  # Assuming 9 images in the test
    assert metadata["embeddings_path"] is not None
    assert metadata["last_modified"] is not None


# test that we can delete an image
def test_delete_image(
    client: TestClient, new_album: dict, monkeypatch: pytest.MonkeyPatch
):
    """Test the ability to delete an image."""
    build_index(client, new_album, monkeypatch)

    album_key = new_album["key"]

    # === DEBUG: Check cache state before deletion ===
    print(f"\n=== BEFORE DELETION ===")
    print(f"Cache info: {_open_npz_file.cache_info()}")
    
    # Fetch the first slide, check its index
    response = client.get(f"/retrieve_image/{album_key}/0")
    data = response.json()
    assert data.get("index") == 0

    # Get the filename
    filename_to_delete = data.get("filename")
    assert filename_to_delete is not None

    print(f"\n=== ABOUT TO DELETE ===")
    print(f"Cache info: {_open_npz_file.cache_info()}")
    
    # Delete the image
    response = client.delete(f"/delete_image/{album_key}/0")
    assert response.status_code == 200
    assert response.json().get("success") is True

    print(f"\n=== AFTER DELETION ===")
    print(f"Cache info: {_open_npz_file.cache_info()}")
    
    # Force clear cache to verify it's not a cache issue
    _open_npz_file.cache_clear()
    print(f"Cache cleared manually: {_open_npz_file.cache_info()}")

    # Check that the index has been updated
    response = client.get(f"/index_metadata/{album_key}")
    assert response.status_code == 200
    metadata = response.json()
    
    print(f"\n=== METADATA CHECK ===")
    print(f"Expected count: {TEST_IMAGE_COUNT - 1}")
    print(f"Actual count: {metadata['filename_count']}")
    print(f"Embeddings path: {metadata['embeddings_path']}")
    print(f"Cache info after metadata call: {_open_npz_file.cache_info()}")
    
    # Let's also directly check the file on disk
    from photomap.backend.config import get_config_manager
    config = get_config_manager().get_album(album_key)
    index_path = Path(config.index)
    print(f"\n=== DIRECT FILE CHECK ===")
    print(f"Index path: {index_path}")
    print(f"Index path resolved: {index_path.resolve()}")
    
    # Load directly from disk without cache
    import numpy as np
    with np.load(index_path, allow_pickle=True) as data:
        disk_count = len(data["filenames"])
        print(f"Direct disk read count: {disk_count}")
    
    assert (
        metadata["filename_count"] == TEST_IMAGE_COUNT - 1
    )  # One less image after deletion

    directory = Path(new_album["image_paths"][0])
    assert not Path(
        directory, filename_to_delete
    ).exists(), "Image file should be deleted"