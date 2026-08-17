from collections import Counter
from pathlib import Path

import pytest
from fixtures import build_index, count_test_images, fetch_filename

from photomap.backend.video import ffmpeg_exe

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


@pytest.mark.skipif(
    ffmpeg_exe() is None, reason="no bundled ffmpeg binary on this platform"
)
def test_umap_data_reports_media_type(client, new_media_album, monkeypatch):
    """The map needs a per-point media type to filter on.

    Derived from the filename suffix rather than stored per-image, so no npz
    change and no migration.

    Skipped without ffmpeg: the videos would simply not be indexed and this
    would fail rather than skip, unlike every other video test in the suite.
    """
    build_index(client, new_media_album)

    response = client.get(f"umap_data/{new_media_album['key']}")
    assert response.status_code == 200
    points = response.json()

    assert all("media" in point for point in points)
    media_counts = Counter(point["media"] for point in points)
    assert media_counts["video"] > 0, "the mixed album should contain videos"
    assert media_counts["image"] == TEST_IMAGE_COUNT


def test_umap_data_reports_image_only_albums_as_all_images(client, new_album, monkeypatch):
    """An index predating video support must report "image" throughout."""
    build_index(client, new_album)

    points = client.get(f"umap_data/{new_album['key']}").json()

    assert points
    assert all(point["media"] == "image" for point in points)
