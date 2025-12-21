from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from fixtures import build_index, client, count_test_images, fetch_filename, new_album

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

    # Fetch the first slide, check its index
    response = client.get(f"/retrieve_image/{album_key}/0")
    data = response.json()
    assert data.get("index") == 0

    # Get the filename
    filename_to_delete = data.get("filename")
    assert filename_to_delete is not None

    # Delete the image
    response = client.delete(f"/delete_image/{album_key}/0")
    assert response.status_code == 200
    assert response.json().get("success") is True

    # Check that the index has been updated
    response = client.get(f"/index_metadata/{album_key}")
    assert response.status_code == 200
    metadata = response.json()
    assert (
        metadata["filename_count"] == TEST_IMAGE_COUNT - 1
    )  # One less image after deletion

    directory = Path(new_album["image_paths"][0])
    assert not Path(
        directory, filename_to_delete
    ).exists(), "Image file should be deleted"


# test that we can move images
def test_move_images(
    client: TestClient, new_album: dict, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """Test the ability to move images to a different directory."""
    build_index(client, new_album, monkeypatch)

    album_key = new_album["key"]

    # Get the first image path
    response = client.get(f"/retrieve_image/{album_key}/0")
    data = response.json()
    assert data.get("index") == 0
    original_filename = data.get("filename")
    assert original_filename is not None

    # Create a target directory
    target_dir = tmp_path / "target_folder"
    target_dir.mkdir()

    # Move the first image
    response = client.post(
        f"/move_images/{album_key}",
        json={"indices": [0], "target_directory": str(target_dir)},
    )
    assert response.status_code == 200
    result = response.json()
    assert result.get("success") is True
    assert result.get("moved_count") == 1
    assert original_filename in result.get("moved_files", [])

    # Check that the file exists in the new location
    new_path = target_dir / original_filename
    assert new_path.exists(), "Image should exist in target directory"

    # Check that the file no longer exists in the old location
    old_path = Path(new_album["image_paths"][0]) / original_filename
    assert not old_path.exists(), "Image should not exist in original directory"

    # Verify the image can still be retrieved with updated path
    response = client.get(f"/retrieve_image/{album_key}/0")
    data = response.json()
    # Check that the filepath has been updated to the new location
    assert new_path.as_posix() in data.get("filepath", "")


def test_move_images_to_same_folder(
    client: TestClient, new_album: dict, monkeypatch: pytest.MonkeyPatch
):
    """Test moving images to the same folder they're already in."""
    build_index(client, new_album, monkeypatch)

    album_key = new_album["key"]

    # Get the original directory
    response = client.get(f"/image_path/{album_key}/0")
    assert response.status_code == 200
    image_path = response.text
    original_dir = Path(image_path).parent

    # Try to move to the same directory
    response = client.post(
        f"/move_images/{album_key}",
        json={"indices": [0], "target_directory": str(original_dir)},
    )
    assert response.status_code == 200
    result = response.json()
    assert result.get("same_folder_count") == 1


def test_move_images_nonexistent_directory(
    client: TestClient, new_album: dict, monkeypatch: pytest.MonkeyPatch
):
    """Test moving images to a non-existent directory."""
    build_index(client, new_album, monkeypatch)

    album_key = new_album["key"]

    # Try to move to a non-existent directory
    response = client.post(
        f"/move_images/{album_key}",
        json={"indices": [0], "target_directory": "/nonexistent/directory"},
    )
    assert response.status_code == 400
    assert "does not exist" in response.json().get("detail", "").lower()


def test_move_images_file_exists(
    client: TestClient, new_album: dict, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """Test moving images when a file with the same name exists in target."""
    build_index(client, new_album, monkeypatch)

    album_key = new_album["key"]

    # Get the first image filename
    response = client.get(f"/retrieve_image/{album_key}/0")
    data = response.json()
    original_filename = data.get("filename")

    # Create a target directory with a file of the same name
    target_dir = tmp_path / "target_folder"
    target_dir.mkdir()
    existing_file = target_dir / original_filename
    existing_file.write_text("existing content")

    # Try to move the image
    response = client.post(
        f"/move_images/{album_key}",
        json={"indices": [0], "target_directory": str(target_dir)},
    )
    assert response.status_code == 200
    result = response.json()
    assert result.get("error_count") == 1
    assert any("already exists" in error for error in result.get("errors", []))


def test_create_directory(client: TestClient, tmp_path: Path):
    """Test the ability to create a new directory."""
    # Create a test directory
    test_dir = tmp_path / "test_parent"
    test_dir.mkdir()

    # Test creating a new directory
    response = client.post(
        "/filetree/create_directory",
        json={"parent_path": str(test_dir), "directory_name": "new_folder"},
    )
    assert response.status_code == 200
    result = response.json()
    assert result.get("success") is True
    assert result.get("name") == "new_folder"

    # Verify the directory was created
    new_dir = test_dir / "new_folder"
    assert new_dir.exists()
    assert new_dir.is_dir()


def test_create_directory_invalid_name(client: TestClient, tmp_path: Path):
    """Test creating a directory with invalid name."""
    test_dir = tmp_path / "test_parent"
    test_dir.mkdir()

    # Test with invalid character (slash)
    response = client.post(
        "/filetree/create_directory",
        json={"parent_path": str(test_dir), "directory_name": "invalid/name"},
    )
    assert response.status_code == 400
    assert "invalid characters" in response.json().get("detail", "").lower()


def test_create_directory_already_exists(client: TestClient, tmp_path: Path):
    """Test creating a directory that already exists."""
    test_dir = tmp_path / "test_parent"
    test_dir.mkdir()
    existing_dir = test_dir / "existing"
    existing_dir.mkdir()

    # Try to create the same directory again
    response = client.post(
        "/filetree/create_directory",
        json={"parent_path": str(test_dir), "directory_name": "existing"},
    )
    assert response.status_code == 409
    assert "already exists" in response.json().get("detail", "").lower()
