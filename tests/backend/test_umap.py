from pathlib import Path

from fixtures import build_index, count_test_images, fetch_filename

TEST_IMAGE_COUNT = count_test_images()


def test_umap_construction(client, new_album, monkeypatch):
    """Test the ability to retrieve an image URL using the /retrieve_image/ API."""
    build_index(client, new_album)

    album_key = new_album["key"]
    response = client.get(f"umap_data/{new_album['key']}")
    assert response.status_code == 200
    umap_data = response.json()
    # Should match the number of images in the album.
    assert len(umap_data) == TEST_IMAGE_COUNT
    slides = [fetch_filename(client, album_key, i) for i in range(TEST_IMAGE_COUNT)]
    for point in umap_data:
        assert (
            Path(fetch_filename(client, new_album["key"], point["index"])).name
            in slides
        )
        assert point["cluster"] is not None
