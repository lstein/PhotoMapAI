from pathlib import Path

import pytest
from fixtures import build_index, client, count_test_images, fetch_filename, new_album

TEST_IMAGE_COUNT = count_test_images()


def test_retrieve_slide(client, new_album, monkeypatch):
    """Test the ability to retrieve an image URL using the /retrieve_image/ API."""
    build_index(client, new_album, monkeypatch)

    # Retrieve the list of indexed images from the album config
    album_key = new_album["key"]

    # Test sequential retrieval using /retrieve_image/{album}
    slides = []
    for i in range(TEST_IMAGE_COUNT):
        response = client.get(f"/retrieve_image/{album_key}/{i}")
        assert response.status_code == 200
        slide_metadata = response.json()
        assert slide_metadata["filename"] is not None
        assert slide_metadata["index"] == i
        slides.append(slide_metadata["filename"])
    assert len(slides) == TEST_IMAGE_COUNT
    assert len(set(slides)) == TEST_IMAGE_COUNT  # Ensure all slides are unique


def test_retrieve_image(client, new_album, monkeypatch):
    """Test retrieving an image by offset."""
    build_index(client, new_album, monkeypatch)

    album_key = new_album["key"]

    # Retrieve the second image
    filename2 = fetch_filename(client, album_key, 1)
    assert filename2 is not None

    # Retrieve the subsequent image
    response = client.get(f"/images/{album_key}/{filename2}")
    assert response.status_code == 200
    image_data = response.content
    assert image_data  # Ensure we received image data
    # compare data contents to the original image
    src_images = Path(__file__).parent / "test_images"
    original_image = src_images / filename2
    assert original_image.exists()
    with open(original_image, "rb") as f:
        original_data = f.read()
    assert image_data == original_data
