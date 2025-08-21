import time
from base64 import b64encode
from pathlib import Path
from urllib.parse import quote

import pytest
from fixtures import (
    client,
    count_test_images,
    fetch_filename,
    new_album,
    poll_during_indexing,
)

TEST_IMAGE_COUNT = count_test_images()


def test_index_update(client, new_album, monkeypatch):
    """Test the creation of an index for the given album."""
    from photomap.backend.embeddings import Embeddings

    monkeypatch.setattr(
        Embeddings, "minimum_image_size", 10 * 1024
    )  # Set minimum image size to 10K for testing
    # Start async index update
    response = client.post(f"/update_index_async", json={"album_key": new_album["key"]})
    assert response.status_code == 202
    task_id = response.json().get("task_id")
    assert task_id is not None
    try:
        poll_during_indexing(client, new_album["key"])
    except TimeoutError as e:
        pytest.fail(f"Indexing did not complete: {str(e)}")

    # test that the index exists
    response = client.get(f"/index_exists/{new_album['key']}")
    assert response.status_code == 200
    exists = response.json().get("exists")
    assert exists is True

    # Check that the embedding index contains 9 images
    response = client.get(f"/album/{new_album['key']}")
    assert response.status_code == 200
    embeddings_path = response.json().get("index")
    assert embeddings_path is not None
    embeddings = Embeddings.open_cached_embeddings(embeddings_path)
    assert embeddings is not None
    assert len(embeddings["filenames"]) == TEST_IMAGE_COUNT

    # Ask the API for the index metadata and ensure it matches the number of index files
    response = client.get(f"/index_metadata/{new_album['key']}")
    assert response.status_code == 200
    metadata = response.json()
    assert metadata["filename_count"] == len(embeddings["filenames"])
    assert Path(metadata["embeddings_path"]).resolve().as_posix() == Path(embeddings_path).resolve().as_posix()
    assert metadata["last_modified"] is not None


def test_index_exists(client, new_album, monkeypatch):
    """Test the index_exists endpoint."""

    from photomap.backend.embeddings import Embeddings

    monkeypatch.setattr(
        Embeddings, "minimum_image_size", 10 * 1024
    )  # Set minimum image size to 10K for testing

    response = client.get(f"/index_exists/{new_album['key']}")
    assert response.status_code == 200
    exists = response.json().get("exists")
    assert exists is False  # Index should not exist before creation

    # Now create the index
    response = client.post(f"/update_index_async", json={"album_key": new_album["key"]})
    assert response.status_code == 202  # Index creation started
    try:
        poll_during_indexing(client, new_album["key"])
    except TimeoutError as e:
        pytest.fail(f"Indexing did not complete: {str(e)}")

    # now it should exist
    response = client.get(f"/index_exists/{new_album['key']}")
    assert response.status_code == 200
    exists = response.json().get("exists")
    assert exists is True  # Index should exist after creation

    # Now delete the album and check again
    response = client.delete(f"/delete_album/{new_album['key']}")
    assert response.status_code == 200

    response = client.get(f"/index_exists/{new_album['key']}")
    assert response.status_code == 404  # Index should not exist anymore
    assert response.json().get("exists", False) is False


def test_image_search(client, new_album, monkeypatch):
    """Test the search functionality."""
    from photomap.backend.embeddings import Embeddings

    TEST_IMAGE_FILE = "./tests/test_images/flower1.jpeg"
    TEST_TEXT_FILE = "./tests/test_images/building1.jpeg"

    monkeypatch.setattr(
        Embeddings, "minimum_image_size", 10 * 1024
    )  # Set minimum image size to 10K for testing

    # Create the index first
    response = client.post(f"/update_index_async", json={"album_key": new_album["key"]})
    assert response.status_code == 202
    try:
        poll_during_indexing(client, new_album["key"])
    except TimeoutError as e:
        pytest.fail(f"Indexing did not complete: {str(e)}")

    # Now perform a search
    with open(TEST_IMAGE_FILE, "rb") as image_file:
        image_data = b64encode(image_file.read()).decode("utf-8")

    response = client.post(
        f"/search_with_text_and_image/{quote(new_album['key'])}",
        json={
            "image_data": image_data,
        },
    )
    assert response.status_code == 200
    slide_summary = response.json()
    assert slide_summary is not None
    assert slide_summary.get("results") is not None
    assert len(slide_summary["results"]) > 0
    filenames = [
        fetch_filename(client, new_album["key"], result["index"])
        for result in slide_summary["results"]
        if result["score"] > 0.6
    ]

    assert (
        Path(TEST_IMAGE_FILE).name in filenames
    ), "Image search did not return expected image"
    assert (
        Path(TEST_TEXT_FILE).name not in filenames
    ), "Image search returned unexpected image"


def test_text_search(client, new_album, monkeypatch):
    """Test the search functionality."""
    from photomap.backend.embeddings import Embeddings

    TEST_POS_FILE = "./tests/test_images/flower1.jpeg"
    TEST_NEG_FILE = "./tests/test_images/building1.jpeg"

    monkeypatch.setattr(
        Embeddings, "minimum_image_size", 10 * 1024
    )  # Set minimum image size to 10K for testing

    # Create the index first
    response = client.post(f"/update_index_async", json={"album_key": new_album["key"]})
    assert response.status_code == 202
    try:
        poll_during_indexing(client, new_album["key"])
    except TimeoutError as e:
        pytest.fail(f"Indexing did not complete: {str(e)}")

    # Now perform a search
    response = client.post(
        f"/search_with_text_and_image/{quote(new_album['key'])}",
        json={
            "positive_query": "flower",
            "negative_query": "building",
            "negative_weight": 0.1,
            "positive_weight": 0.9,
        },
    )
    assert response.status_code == 200
    slide_summary = response.json()
    assert slide_summary is not None
    assert slide_summary.get("results") is not None
    assert len(slide_summary["results"]) > 0
    filenames = [
        fetch_filename(client, new_album["key"], result["index"])
        for result in slide_summary["results"]
        if result["score"] > 0.25
    ]
    assert (
        Path(TEST_POS_FILE).name in filenames
    ), "Text search did not return expected image"
    assert (
        Path(TEST_NEG_FILE).name not in filenames
    ), "Text search returned unexpected image"
