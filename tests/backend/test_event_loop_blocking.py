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
import threading
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
    # Wrapping the real cache type rather than a bare lru_cache keeps the
    # dedupe and generation behaviour these endpoints depend on.
    monkeypatch.setattr(
        embeddings_module,
        "_open_npz_file",
        embeddings_module._NpzIndexCache(spy),
    )
    embeddings_module._open_npz_file.cache_clear()
    return threads


@pytest.mark.parametrize(
    "request_for",
    [
        lambda key: ("GET", f"/umap_data/{key}", None),
        lambda key: ("GET", f"/image_info/{key}/0", None),
        lambda key: ("GET", f"/get_metadata/{key}/0", None),
        lambda key: ("GET", f"/index_metadata/{key}", None),
        # The slideshow's own endpoint, and the one most likely to take
        # the cold miss: it fires once per slide.
        lambda key: ("GET", f"/retrieve_image/{key}/0", None),
        # A thumbnail grid fires these in a burst.
        lambda key: ("GET", f"/thumbnails/{key}/0", None),
        lambda key: ("GET", f"/image_path/{key}/0", None),
        lambda key: ("POST", f"/search_with_text_and_image/{key}",
                     {"positive_query": "a photo"}),
        lambda key: ("POST", f"/download_images_zip/{key}", {"indices": [0]}),
        lambda key: ("POST", "/api/curation/curate_sync",
                     {"target_count": 2, "iterations": 1, "album": key,
                      "method": "fps", "excluded_indices": []}),
    ],
    ids=[
        "umap_data",
        "image_info",
        "get_metadata",
        "index_metadata",
        "retrieve_image",
        "thumbnails",
        "image_path",
        "search",
        "download_images_zip",
        "curate_sync",
    ],
)
def test_endpoints_do_not_load_the_index_on_the_event_loop(
    client, new_album, loop_thread_loads, request_for
):
    build_index(client, new_album)
    embeddings_module._open_npz_file.cache_clear()
    loop_thread_loads.clear()

    method, url, body = request_for(new_album["key"])
    assert client.request(method, url, json=body).status_code == 200

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


def test_a_reader_landing_mid_reprime_cannot_restore_a_deleted_image(
    client, new_album, monkeypatch
):
    """The narrow version of the race above: the reader lands *during* step 6.

    The test before this one drives a reader that finishes while the rewrite
    is in flight, which clearing the cache afterwards is enough to handle. It
    is not enough one step later. The re-prime is itself a full load, and a
    plain cache takes whichever value arrives first and refuses to overwrite
    it -- so a reader finishing inside that window installs the *pre*-delete
    snapshot and the re-prime's own fresh result is silently discarded. The
    result is a cache that serves a deleted image indefinitely while the
    delete path reports success.

    Driven deterministically: the reader loads the still-unmodified file
    during the write, then is held until the re-prime has started its own
    load, which is exactly the interleaving described above.
    """
    build_index(client, new_album)

    from photomap.backend.routers.album import get_embeddings_for_album

    embeddings = get_embeddings_for_album(new_album["key"])
    path = embeddings.embeddings_path
    before = len(embeddings.indexes["sorted_filenames"])

    real_load = embeddings_module._open_npz_file.__wrapped__
    reader_loaded = threading.Event()
    reprime_started = threading.Event()
    reader_finished = threading.Event()
    write_done = threading.Event()

    def spy(target):
        if threading.current_thread().name == "racing-reader":
            data = real_load(target)  # the pre-delete file is still on disk
            reader_loaded.set()
            reprime_started.wait(10)  # hold until step 6's load is underway
            return data
        if write_done.is_set():  # this call is step 6's re-prime
            reprime_started.set()
            reader_finished.wait(10)
            return real_load(target)
        return real_load(target)

    monkeypatch.setattr(
        embeddings_module, "_open_npz_file", embeddings_module._NpzIndexCache(spy)
    )
    embeddings_module._open_npz_file.cache_clear()

    real_savez = embeddings_module.atomic_savez

    def savez_with_a_racing_reader(target, **arrays):
        reader = threading.Thread(
            target=lambda: (
                embeddings_module._open_npz_file(path),
                reader_finished.set(),
            ),
            name="racing-reader",
        )
        reader.start()
        assert reader_loaded.wait(10), "the reader never loaded the pre-delete file"
        result = real_savez(target, **arrays)
        write_done.set()
        return result

    monkeypatch.setattr(embeddings_module, "atomic_savez", savez_with_a_racing_reader)

    embeddings.remove_image_from_embeddings(0)
    assert reader_finished.wait(10), "the racing reader never ran; the test proves nothing"

    served = len(embeddings_module._open_npz_file(path)["sorted_filenames"])
    assert served == before - 1, (
        f"the cache serves {served} filenames after a delete left {before - 1} "
        "on disk: the racing reader's pre-delete snapshot won"
    )


def test_concurrent_readers_share_one_load(client, new_album, monkeypatch):
    """A burst of requests for an uncached index must not each load it.

    Nothing deduped in-flight loads while readers ran on the event loop --
    the loop did it, by never letting two overlap. Worker threads removed
    that, and a full load is hundreds of megabytes: eight concurrent requests
    for a 50,000-image index measured 1.7 GB peak RSS against 0.26 GB for
    one. Latecomers have to wait on the load already running.
    """
    build_index(client, new_album)

    from photomap.backend.routers.album import get_embeddings_for_album

    embeddings = get_embeddings_for_album(new_album["key"])
    real_load = embeddings_module._open_npz_file.__wrapped__
    loads = []
    all_readers_waiting = threading.Event()

    def spy(target):
        loads.append(target)
        # Hold the first load open until every reader has had a chance to
        # queue up behind it. Without the wait the first could plausibly
        # finish before the others start, and the test would pass vacuously.
        all_readers_waiting.wait(5)
        return real_load(target)

    monkeypatch.setattr(
        embeddings_module, "_open_npz_file", embeddings_module._NpzIndexCache(spy)
    )
    embeddings_module._open_npz_file.cache_clear()

    async def eight_at_once():
        readers = [embeddings.load_indexes() for _ in range(8)]
        gathered = asyncio.gather(*readers)
        await asyncio.sleep(0.5)  # let them all reach the cache
        all_readers_waiting.set()
        return await gathered

    results = asyncio.run(eight_at_once())

    assert len(results) == 8
    assert all(r is results[0] for r in results), "readers got different snapshots"
    assert len(loads) == 1, f"{len(loads)} concurrent loads of the same index, expected 1"


def test_zip_download_without_an_index_still_answers(client, new_album):
    """Priming the index for the zip must not turn a missing index into a 500.

    Both loops in ``/download_images_zip/`` already treat an unresolvable
    index as "no files matched" and hand back an empty archive. The priming
    call added in front of them reads the same index and would otherwise
    raise ``FileNotFoundError`` straight out of the handler.
    """
    embeddings_module._open_npz_file.cache_clear()

    response = client.post(
        f"/download_images_zip/{new_album['key']}", json={"indices": [0, 1]}
    )

    assert response.status_code == 200
