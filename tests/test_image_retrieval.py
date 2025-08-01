from pathlib import Path

import pytest
from fixtures import build_index, client, fetch_filename, new_album


def test_retrieve_by_offset(client, new_album, monkeypatch):
    """Test the ability to retrieve an image URL using the /retrieve_image/ API."""
    build_index(client, new_album, monkeypatch)

    # Retrieve the list of indexed images from the album config
    album_key = new_album["key"]

    # Test sequential retrieval using /retrieve_image/{album}
    slides = []
    for i in range(9):
        response = client.get(f"/retrieve_image/{album_key}?offset={i}&random=false")
        assert response.status_code == 200
        slide_metadata = response.json()
        assert slide_metadata["filename"] is not None
        assert slide_metadata["index"] == i
        slides.append(slide_metadata["filename"])
    assert len(slides) == 9
    assert len(set(slides)) == 9  # Ensure all slides are unique


def test_retrieve_random_image(client, new_album, monkeypatch):
    build_index(client, new_album, monkeypatch)
    # Test random retrieval
    album_key = new_album["key"]
    slides = [fetch_filename(client, album_key, i) for i in range(9)]
    assert len(slides) == 9

    response = client.get(f"/retrieve_image/{album_key}?random=true")
    assert response.status_code == 200
    slide_metadata = response.json()
    slide_random = slide_metadata["filename"]
    assert slide_random is not None
    assert slide_random in slides  # Should be one of the indexed images

    random_slides = []
    for i in range(9):
        response = client.get(f"/retrieve_image/{album_key}?offset=0&random=true")
        assert response.status_code == 200
        slide_metadata = response.json()
        random_slides.append(slide_metadata["filename"])
    unique = set(random_slides)
    assert len(unique) > 1  # should get several different slides


def test_retrieve_image_by_offset(client, new_album, monkeypatch):
    """Test retrieving an image by offset."""
    build_index(client, new_album, monkeypatch)

    album_key = new_album["key"]

    # Retrieve the second image
    filename2 = fetch_filename(client, album_key, 1)
    assert filename2 is not None

    # Retrieve the subsequent image
    response = client.get(
        f"/retrieve_image/{album_key}?current_image={filename2}&offset=1"
    )
    assert response.status_code == 200
    slide_metadata = response.json()
    assert slide_metadata["filename"] is not None
    assert slide_metadata["index"] == 2
