"""Concurrent index operations must not traverse the filesystem at the same
time. The scan opens every candidate file's header for the dimension gate, so
it is seek- and GIL-bound: two overlapping traversals run far slower than the
same two back-to-back (see ``_scan_semaphore`` in ``embeddings.py``).
"""

import asyncio
import threading
import time
from pathlib import Path

from photomap.backend import embeddings as embeddings_module
from photomap.backend.embeddings import Embeddings


def test_concurrent_scans_are_serialized(tmp_path: Path, monkeypatch) -> None:
    active = 0
    max_active = 0
    lock = threading.Lock()

    def fake_scan(self, image_paths_or_dir, exts=None, progress_callback=None, **kwargs):
        nonlocal active, max_active
        with lock:
            active += 1
            max_active = max(max_active, active)
        # Long enough that unserialized scans would reliably overlap.
        time.sleep(0.05)
        with lock:
            active -= 1
        return []

    monkeypatch.setattr(Embeddings, "get_image_files", fake_scan)
    # The semaphore is created lazily and may be bound to a previous test's
    # event loop; reset so this test's asyncio.run() gets a fresh one.
    monkeypatch.setattr(embeddings_module, "_scan_semaphore", None)

    async def run_both() -> None:
        one = Embeddings(embeddings_path=tmp_path / "a" / "embeddings.npz")
        two = Embeddings(embeddings_path=tmp_path / "b" / "embeddings.npz")
        # The empty scan result makes create_index_async record a "no images"
        # error and return before any encoder work — the traversal is all
        # that runs, which is exactly the stage under test.
        await asyncio.gather(
            one.create_index_async(tmp_path / "imgs_a", "scan_serialization_a"),
            two.create_index_async(tmp_path / "imgs_b", "scan_serialization_b"),
        )

    asyncio.run(run_both())

    assert max_active == 1, "two album scans overlapped despite _scan_semaphore"
