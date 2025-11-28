from pathlib import Path

import pytest
from fixtures import build_index, client, fetch_filename, new_album


def test_umap_construction(client, new_album, monkeypatch):
    """Test the ability to retrieve an image URL using the /retrieve_image/ API."""
    build_index(client, new_album, monkeypatch)

    album_key = new_album["key"]
    response = client.get(f"umap_data/{new_album['key']}")
    assert response.status_code == 200
    umap_data = response.json()
    assert len(umap_data) == 9  # Should match the number of images in the album
    slides = [fetch_filename(client, album_key, i) for i in range(9)]
    for point in umap_data:
        assert (
            Path(fetch_filename(client, new_album["key"], point["index"])).name
            in slides
        )
        assert point["cluster"] is not None
