"""Deleting an album removes the index directory PhotoMap created for it (#433).

Only a directory PhotoMap itself chose is removed — ``photomap_index`` next to
the photos, or the per-user board index directory — and never one another
album still uses, nor a user-chosen custom location.
"""

from pathlib import Path

import numpy as np
import pytest
from fixtures import client  # noqa: F401

from photomap.backend.progress import progress_tracker
from photomap.backend.util import atomic_savez

ENCODER_SPEC = "openai-clip:ViT-B/32"


def _seed_index(index_path: Path) -> None:
    """A stand-in index plus the side files PhotoMap keeps next to it."""
    index_path.parent.mkdir(parents=True, exist_ok=True)
    atomic_savez(index_path, embeddings=np.zeros((0, 4), dtype=np.float32))
    (index_path.parent / "umap.npz").write_bytes(b"x")
    (index_path.parent / "thumbnails").mkdir()
    (index_path.parent / "thumbnails" / "a.png").write_bytes(b"x")


def _add_album(client, key: str, photos: Path, index_path: Path) -> None:  # noqa: F811
    album = {
        "key": key,
        "name": key,
        "image_paths": [photos.as_posix()],
        "index": index_path.as_posix(),
        "encoder_spec": ENCODER_SPEC,
    }
    response = client.post("/add_album/", json=album)
    assert response.status_code == 201, response.text


@pytest.fixture
def photos(tmp_path) -> Path:
    photos = tmp_path / "photos"
    photos.mkdir()
    (photos / "keep.jpg").write_bytes(b"not really a jpeg")
    return photos


def test_delete_album_removes_photomap_index(client, photos):  # noqa: F811
    index_path = photos / "photomap_index" / "embeddings.npz"
    _seed_index(index_path)
    _add_album(client, "idx_album", photos, index_path)

    response = client.delete("/delete_album/idx_album")
    assert response.status_code == 200, response.text

    assert not index_path.parent.exists()
    # The photos themselves are never touched.
    assert (photos / "keep.jpg").exists()


def test_delete_album_keeps_index_shared_with_another_album(client, photos):  # noqa: F811
    index_path = photos / "photomap_index" / "embeddings.npz"
    _seed_index(index_path)
    _add_album(client, "shared_a", photos, index_path)
    _add_album(client, "shared_b", photos, index_path)
    try:
        assert client.delete("/delete_album/shared_a").status_code == 200
        assert index_path.exists()

        # Once the last user goes, so does the directory.
        assert client.delete("/delete_album/shared_b").status_code == 200
        assert not index_path.parent.exists()
    finally:
        client.delete("/delete_album/shared_a")
        client.delete("/delete_album/shared_b")


def test_delete_album_leaves_custom_index_location_alone(client, photos, tmp_path):  # noqa: F811
    # A user-chosen folder can hold anything; it is not ours to remove.
    custom_dir = tmp_path / "my_stuff"
    index_path = custom_dir / "embeddings.npz"
    _seed_index(index_path)
    (custom_dir / "unrelated.txt").write_text("mine")
    _add_album(client, "custom_album", photos, index_path)

    assert client.delete("/delete_album/custom_album").status_code == 200

    assert index_path.exists()
    assert (custom_dir / "unrelated.txt").exists()


def test_delete_album_refused_while_indexing(client, photos):  # noqa: F811
    # Indexing writes into the directory at points that never check for a
    # cancel, so a delete under it would leave a recreated orphan behind.
    index_path = photos / "photomap_index" / "embeddings.npz"
    _seed_index(index_path)
    _add_album(client, "busy_album", photos, index_path)
    progress_tracker.start_operation("busy_album", 10, "mapping")
    try:
        response = client.delete("/delete_album/busy_album")
        assert response.status_code == 409
        assert "being indexed" in response.json()["detail"]
        assert index_path.exists()
        assert client.get("/available_albums/").status_code == 200
    finally:
        progress_tracker.remove_progress("busy_album")
        client.delete("/delete_album/busy_album")
    assert not index_path.parent.exists()


def test_delete_unknown_album_is_404(client):  # noqa: F811
    assert client.delete("/delete_album/no_such_album").status_code == 404


def test_shared_index_detected_through_a_second_spelling(client, photos, tmp_path):  # noqa: F811
    # Two spellings of one folder (here a symlinked parent; on macOS, a case
    # difference) must still count as "another album uses this index".
    index_path = photos / "photomap_index" / "embeddings.npz"
    _seed_index(index_path)
    alias = tmp_path / "alias"
    alias.symlink_to(photos, target_is_directory=True)
    _add_album(client, "spell_a", photos, index_path)
    _add_album(client, "spell_b", alias, alias / "photomap_index" / "embeddings.npz")
    try:
        assert client.delete("/delete_album/spell_a").status_code == 200
        assert index_path.exists()
    finally:
        client.delete("/delete_album/spell_a")
        client.delete("/delete_album/spell_b")


def test_delete_album_missing_index_dir_is_fine(client, photos):  # noqa: F811
    # Album added but never indexed: nothing to remove, and no error.
    _add_album(client, "never_indexed", photos, photos / "photomap_index" / "embeddings.npz")
    assert client.delete("/delete_album/never_indexed").status_code == 200
