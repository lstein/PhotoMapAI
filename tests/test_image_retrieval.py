from pathlib import Path

import pytest
from fixtures import client, new_album, poll_during_indexing


def test_retrieve(client, new_album, monkeypatch):
    """Test the ability to retrieve an image URL."""
    from clipslide.backend.embeddings import Embeddings

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

    # Test sequential retrieval. We should get 9 different images.
    for i in range(9):
        response = client.get(f"/retrieve/{new_album['key']}?offset={i}&random=false")
        assert response.status_code == 200
        slide_metadata = response.json()
        print(slide_metadata)
        assert slide_metadata["url"] is not None
        assert slide_metadata["album"] == new_album["key"]
        assert slide_metadata["index"] == i
