"""``DELETE /remove_index/{album_key}``, which Rebuild Index runs first.

The endpoint predates the button, but only ever ran as a prelude to
re-indexing, so the one thing it got away with not doing — dropping the
deleted index out of the process-wide ``lru_cache`` — was covered by the
rebuild's own write clearing it moments later. A user-facing button removes
that cover: the rebuild behind it can fail, be cancelled, or simply not be
reached, and the app would go on serving an album whose index is no longer
on disk.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import numpy as np
import pytest
from fixtures import (
    ENCODER_SPEC,
    _write_synthetic_index,
    client,  # noqa: F401
    media_fixture_path,
)

from photomap.backend.embeddings import _open_npz_file


@pytest.fixture
def indexed_album(client, tmp_path):  # noqa: F811
    """An album with a real index file on disk."""
    media_dir = tmp_path / "pics"
    media_dir.mkdir()
    photo = media_dir / "building1.jpeg"
    shutil.copy(
        media_fixture_path("../test_images/building1.jpeg").resolve(), photo
    )

    index_path = media_dir / "photomap_index" / "embeddings.npz"
    _write_synthetic_index(index_path, [photo], [{"Make": "TestCam"}])

    album = {
        "key": "removable_album",
        "name": "Removable",
        "image_paths": [media_dir.as_posix()],
        "index": index_path.as_posix(),
        "umap_eps": 0.1,
        "description": "",
        "encoder_spec": ENCODER_SPEC,
    }
    try:
        assert client.post("/add_album/", json=album).status_code == 201
        yield {**album, "index_path": index_path}
    finally:
        client.delete(f"/delete_album/{album['key']}")


def test_removing_an_index_deletes_the_file(client, indexed_album):  # noqa: F811
    response = client.delete(f"/remove_index/{indexed_album['key']}")

    assert response.status_code == 200
    assert response.json()["success"] is True
    assert not Path(indexed_album["index_path"]).exists()


def test_removing_an_index_drops_it_from_the_cache(client, indexed_album):  # noqa: F811
    """Otherwise the app serves an index that is no longer on disk.

    The read below is what puts it in the cache — exactly as any request
    touching the album would have.
    """
    index_path = Path(indexed_album["index_path"])
    assert len(_open_npz_file(index_path)["filenames"]) == 1

    client.delete(f"/remove_index/{indexed_album['key']}")

    with pytest.raises(FileNotFoundError):
        _open_npz_file(index_path)


def test_removing_a_missing_index_is_a_404(client, indexed_album):  # noqa: F811
    Path(indexed_album["index_path"]).unlink()

    response = client.delete(f"/remove_index/{indexed_album['key']}")

    assert response.status_code == 404


def test_removing_the_index_of_an_unknown_album_is_a_404(client):  # noqa: F811
    assert client.delete("/remove_index/no-such-album").status_code == 404


def test_only_the_index_file_is_removed(client, indexed_album):  # noqa: F811
    """The semantic map, cluster labels and thumbnails are derived and
    self-invalidate by mtime against the index, so a rebuild regenerates
    them — deleting them here would only throw away reusable work.
    """
    index_path = Path(indexed_album["index_path"])
    umap = index_path.parent / "umap.npz"
    np.savez(umap, umap_embeddings=np.zeros((1, 2), dtype=np.float32))
    thumbs = index_path.parent / "thumbnails"
    thumbs.mkdir()
    (thumbs / "0.webp").write_bytes(b"not really a webp")

    client.delete(f"/remove_index/{indexed_album['key']}")

    assert not index_path.exists()
    assert umap.exists()
    assert (thumbs / "0.webp").exists()
