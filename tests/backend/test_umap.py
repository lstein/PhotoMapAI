import os
import time
from collections import Counter
from pathlib import Path

import numpy as np
import pytest
from fixtures import build_index, count_test_images, fetch_filename

from photomap.backend.util import atomic_savez
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


# ---------------------------------------------------------------------------
# Concurrent rebuilds of a stale umap.npz
# ---------------------------------------------------------------------------


def test_a_stale_umap_cache_is_rebuilt_exactly_once(tmp_path, monkeypatch):
    """Two threads finding the same stale cache must not both refit.

    The semantic map fetches ``/umap_data`` and ``/cluster_labels`` in
    parallel and both resolve coordinates off the event loop, so both can hit
    the freshness check before either has written a result. The check reads an
    mtime that is not updated until the fit *finishes*, so it cannot serialize
    them on its own.

    Two fits is not just wasted work: ``UMAP`` is built without a
    ``random_state``, so the two layouts differ, and the endpoints would hand
    back cluster ids describing different coordinates — the divergence the
    map's hover labels depend on not happening.
    """
    import threading

    from photomap.backend.embeddings import Embeddings

    index_path = tmp_path / "embeddings.npz"
    umap_path = tmp_path / "umap.npz"
    rng = np.random.default_rng(0)
    vectors = rng.normal(size=(40, 8)).astype(np.float32)
    index_path.write_bytes(b"")  # only its mtime matters here
    # The index reader wants a full archive; this test is about the lock, so
    # stub it rather than construct one.
    monkeypatch.setattr(
        Embeddings,
        "open_cached_embeddings",
        staticmethod(lambda path: {"embeddings": vectors}),
    )
    # A cache that exists but predates the index: the state any rewrite of
    # the index leaves behind.
    atomic_savez(umap_path, umap=np.zeros((40, 2), dtype=np.float32))
    old = index_path.stat().st_mtime - 100
    os.utime(umap_path, (old, old))

    concurrent = 0
    peak = 0
    calls = 0
    guard = threading.Lock()
    started = threading.Barrier(2)

    def slow_fit(self, embeddings):
        nonlocal concurrent, peak, calls
        with guard:
            concurrent += 1
            peak = max(peak, concurrent)
            calls += 1
        # Hold the "fit" open long enough that a second thread would overlap
        # if nothing excluded it.
        time.sleep(0.3)
        coords = np.ones((embeddings.shape[0], 2), dtype=np.float32)
        atomic_savez(umap_path, umap=coords)
        with guard:
            concurrent -= 1
        return coords

    monkeypatch.setattr(Embeddings, "create_umap_index", slow_fit)

    results = []

    def load():
        emb = Embeddings(embeddings_path=index_path, album_key="concurrent")
        started.wait(timeout=5)
        results.append(emb.umap_embeddings)

    threads = [threading.Thread(target=load) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    assert peak == 1, "two threads refit the same stale UMAP cache concurrently"
    assert calls == 1, "the second caller refit instead of reading what the first wrote"
    assert len(results) == 2
    # Both callers get the same coordinates, which is the point.
    assert np.array_equal(results[0], results[1])
