"""Endpoints must not load an album's index on the event loop.

``Embeddings.indexes`` and ``open_cached_embeddings`` are backed by an
``lru_cache`` holding three entries, so any request touching a fourth album —
or the first request after the index is rewritten — pays a full ``np.load``
of the index, unpickling the per-image metadata array along the way. Measured
at 0.34s for 50,000 images with modest metadata and a warm page cache; a real
library with generation metadata and a cold cache is several times that.

Doing that inside a coroutine stops every other request for the duration:
the slideshow, thumbnail fetches, and the indexing-progress polling that the
user is watching while they wait.

``asyncio.get_running_loop()`` succeeds only on the thread running the loop,
which is what makes "did this happen on the event loop" checkable without
depending on thread names.
"""

import asyncio
from pathlib import Path

import pytest
from fixtures import build_index

from photomap.backend import embeddings as embeddings_module


@pytest.fixture
def loop_thread_loads(monkeypatch):
    """Record every index load, tagged with the kind of thread it ran on."""
    threads = []
    real = embeddings_module._open_npz_file.__wrapped__

    def spy(path):
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            threads.append("worker")
        else:
            threads.append("event-loop")
        return real(path)

    # Patch under the cache so every miss is seen, and start from empty.
    monkeypatch.setattr(
        embeddings_module,
        "_open_npz_file",
        __import__("functools").lru_cache(maxsize=3)(spy),
    )
    embeddings_module._open_npz_file.cache_clear()
    return threads


@pytest.mark.parametrize(
    "request_for",
    [
        lambda key: ("GET", f"/umap_data/{key}"),
        lambda key: ("GET", f"/image_info/{key}/0"),
        lambda key: ("GET", f"/get_metadata/{key}/0"),
        lambda key: ("GET", f"/index_metadata/{key}"),
    ],
    ids=["umap_data", "image_info", "get_metadata", "index_metadata"],
)
def test_endpoints_do_not_load_the_index_on_the_event_loop(
    client, new_album, loop_thread_loads, request_for
):
    build_index(client, new_album)
    embeddings_module._open_npz_file.cache_clear()
    loop_thread_loads.clear()

    method, url = request_for(new_album["key"])
    assert client.request(method, url).status_code == 200

    assert loop_thread_loads, f"{url} never loaded the index; the test proves nothing"
    assert "event-loop" not in loop_thread_loads


def test_a_concurrent_reader_cannot_restore_a_deleted_image(
    client, new_album, monkeypatch
):
    """The delete path re-primes the index cache to verify its own write.

    A reader that missed the cache before the delete cleared it can finish
    loading at any point afterwards and store the pre-delete snapshot — and
    then the re-prime is a cache hit that verifies nothing, so every later
    request goes on serving an image that is no longer in the index. Now
    that readers run in worker threads, that interleaving is reachable.

    Driven deterministically by priming the cache from the still-unmodified
    file during the write itself, which is precisely what a reader that
    loaded just before the rename would have left behind.
    """
    build_index(client, new_album)

    from photomap.backend.routers.album import get_embeddings_for_album

    embeddings = get_embeddings_for_album(new_album["key"])
    path = embeddings.embeddings_path
    before = len(embeddings.indexes["sorted_filenames"])

    real_savez = embeddings_module.atomic_savez
    raced = {"done": False}

    def savez_with_a_racing_reader(target, **arrays):
        if not raced["done"] and Path(target) == Path(path):
            raced["done"] = True
            # The file on disk is still the pre-delete one right now.
            embeddings_module._open_npz_file(path)
        return real_savez(target, **arrays)

    monkeypatch.setattr(embeddings_module, "atomic_savez", savez_with_a_racing_reader)

    embeddings.remove_image_from_embeddings(0)
    assert raced["done"], "the racing reader never ran; the test proves nothing"

    monkeypatch.undo()
    assert (
        len(get_embeddings_for_album(new_album["key"]).indexes["sorted_filenames"])
        == before - 1
    )
    assert client.get(f"/index_metadata/{new_album['key']}").json()["image_count"] == (
        before - 1
    )
