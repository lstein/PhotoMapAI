"""Tests for indexing and curating InvokeAI board-backed albums.

The InvokeAI HTTP API is stubbed at the ``invokeai_client`` layer: a fake
``fetch_board_image_names`` serves a mutable board → image-name mapping, and
the images themselves are UUID-named copies of the bundled test images laid
out under a fake ``<root>/outputs/images`` directory.
"""

import shutil
import time
import uuid
from pathlib import Path

import numpy as np
import pytest
from fastapi import HTTPException

from photomap.backend import invokeai_client

ALBUM_KEY = "board_index_album"


def _index_filenames(index_path: Path) -> set[str]:
    data = np.load(index_path, allow_pickle=True)
    return {Path(str(f)).name for f in data["filenames"]}


def _poll_until(client, album_key, statuses, timeout=60):
    start = time.time()
    while True:
        progress = client.get(f"/index_progress/{album_key}").json()
        if progress["status"] in statuses:
            return progress
        if time.time() - start > timeout:
            raise TimeoutError(f"Indexing stuck in status {progress['status']!r}")
        time.sleep(0.5)


@pytest.fixture
def board_album(client, tmp_path, monkeypatch):
    """A board album whose boards are served by a stubbed InvokeAI client.

    Yields a dict with the fake root, the mutable board mapping, and the
    album's (explicit, tmp_path-local) index path. The index is passed
    explicitly so tests never write into the real per-user data directory.
    """
    images_dir = tmp_path / "invokeai" / "outputs" / "images"
    images_dir.mkdir(parents=True)
    src_images = sorted(
        p for p in (Path(__file__).parent / "test_images").iterdir() if p.is_file()
    )[:4]
    assert len(src_images) == 4, "expected at least 4 bundled test images"
    names = []
    for img in src_images:
        name = f"{uuid.uuid4()}{img.suffix.lower()}"
        shutil.copy(img, images_dir / name)
        names.append(name)

    boards = {"b1": list(names)}

    async def fake_fetch(base_url, board_ids, username, password):
        merged = []
        for board_id in board_ids:
            merged.extend(boards.get(board_id, []))
        return list(dict.fromkeys(merged))

    monkeypatch.setattr(invokeai_client, "fetch_board_image_names", fake_fetch)

    index_path = tmp_path / "index" / "embeddings.npz"
    album = {
        "key": ALBUM_KEY,
        "name": "Board Index Album",
        "source_type": "invokeai_board",
        "invokeai_url": "http://localhost:9090",
        "invokeai_root": (tmp_path / "invokeai").as_posix(),
        "invokeai_board_ids": ["b1"],
        "index": index_path.as_posix(),
        "encoder_spec": "openai-clip:ViT-B/32",
    }
    response = client.post("/add_album/", json=album)
    assert response.status_code == 201, response.text

    yield {
        "album": album,
        "boards": boards,
        "images_dir": images_dir,
        "index_path": index_path,
        "src_images": src_images,
    }

    client.delete(f"/delete_album/{ALBUM_KEY}")


def _build_index(client):
    response = client.post("/update_index_async", json={"album_key": ALBUM_KEY})
    assert response.status_code == 202, response.text
    progress = _poll_until(client, ALBUM_KEY, {"completed", "error"})
    assert progress["status"] == "completed", progress.get("error_message")


def test_board_album_index_contains_board_images(client, board_album):
    _build_index(client)

    metadata = client.get(f"/index_metadata/{ALBUM_KEY}").json()
    assert metadata["filename_count"] == 4
    assert _index_filenames(board_album["index_path"]) == set(
        board_album["boards"]["b1"]
    )


def test_missing_board_images_surface_completion_warning(client, board_album):
    """A board name InvokeAI lists but that's absent on disk is skipped, and the
    discrepancy is surfaced as a non-fatal warning on the completed run (the
    InvokeAI gallery shows a higher count than the album indexes)."""
    # 4 real images + 1 ghost that has no file under outputs/images.
    ghost = f"{uuid.uuid4()}.png"
    board_album["boards"]["b1"].append(ghost)

    _build_index(client)

    progress = client.get(f"/index_progress/{ALBUM_KEY}").json()
    assert progress["status"] == "completed"
    assert progress["warning_message"]
    assert "1 of 5" in progress["warning_message"]
    # The real images still index; only the ghost is dropped.
    metadata = client.get(f"/index_metadata/{ALBUM_KEY}").json()
    assert metadata["filename_count"] == 4


def test_complete_board_index_has_no_warning(client, board_album):
    """When every listed image exists, the completed run carries no warning."""
    _build_index(client)

    progress = client.get(f"/index_progress/{ALBUM_KEY}").json()
    assert progress["status"] == "completed"
    assert progress["warning_message"] is None


def test_board_membership_changes_flow_through_update(client, board_album):
    _build_index(client)

    # Drop one image from the board and add a brand-new one.
    removed = board_album["boards"]["b1"].pop(0)
    new_name = f"{uuid.uuid4()}{board_album['src_images'][0].suffix.lower()}"
    shutil.copy(
        board_album["src_images"][0], board_album["images_dir"] / new_name
    )
    board_album["boards"]["b1"].append(new_name)

    _build_index(client)

    filenames = _index_filenames(board_album["index_path"])
    assert removed not in filenames
    assert new_name in filenames
    assert len(filenames) == 4


def test_unreachable_invokeai_fails_indexing_and_keeps_old_index(
    client, board_album, monkeypatch
):
    _build_index(client)
    before = board_album["index_path"].read_bytes()

    async def broken_fetch(base_url, board_ids, username, password):
        raise HTTPException(status_code=502, detail="connection refused")

    monkeypatch.setattr(invokeai_client, "fetch_board_image_names", broken_fetch)

    response = client.post("/update_index_async", json={"album_key": ALBUM_KEY})
    assert response.status_code == 202
    progress = _poll_until(client, ALBUM_KEY, {"completed", "error"})
    assert progress["status"] == "error"
    assert "InvokeAI" in progress["error_message"]
    # The failure happened before any write — the old index is untouched.
    assert board_album["index_path"].read_bytes() == before


def test_wrong_invokeai_root_gives_pointed_error(client, board_album, monkeypatch):
    """If none of the board's images exist locally the error must point at
    the root directory rather than a generic 'no images found'."""
    shutil.rmtree(board_album["images_dir"])

    response = client.post("/update_index_async", json={"album_key": ALBUM_KEY})
    assert response.status_code == 202
    progress = _poll_until(client, ALBUM_KEY, {"completed", "error"})
    assert progress["status"] == "error"
    assert "root directory" in progress["error_message"]


def test_delete_image_routes_through_invokeai(client, board_album, monkeypatch):
    _build_index(client)

    captured = {}

    async def fake_delete(base_url, image_name, username, password):
        captured["base_url"] = base_url
        captured["image_name"] = image_name

    monkeypatch.setattr(invokeai_client, "delete_image", fake_delete)

    # Resolve which file sorted-index 0 refers to before deleting it.
    first_file = client.get(f"/retrieve_image/{ALBUM_KEY}/0").json()["filename"]

    response = client.delete(f"/delete_image/{ALBUM_KEY}/0")
    assert response.status_code == 200, response.text

    assert captured["base_url"] == "http://localhost:9090"
    assert captured["image_name"] == Path(first_file).name
    # The local file is NOT touched directly — InvokeAI owns it.
    assert (board_album["images_dir"] / Path(first_file).name).exists()
    # But the index row is gone.
    metadata = client.get(f"/index_metadata/{ALBUM_KEY}").json()
    assert metadata["filename_count"] == 3
    assert Path(first_file).name not in _index_filenames(board_album["index_path"])


def test_delete_image_failure_leaves_index_intact(client, board_album, monkeypatch):
    _build_index(client)

    async def broken_delete(base_url, image_name, username, password):
        raise HTTPException(status_code=502, detail="backend down")

    monkeypatch.setattr(invokeai_client, "delete_image", broken_delete)

    response = client.delete(f"/delete_image/{ALBUM_KEY}/0")
    assert response.status_code == 502

    metadata = client.get(f"/index_metadata/{ALBUM_KEY}").json()
    assert metadata["filename_count"] == 4


def test_move_images_rejected_for_board_albums(client, board_album, tmp_path):
    _build_index(client)

    target = tmp_path / "elsewhere"
    target.mkdir()
    response = client.post(
        f"/move_images/{ALBUM_KEY}",
        json={"indices": [0], "target_directory": target.as_posix()},
    )
    assert response.status_code == 400
    assert "not supported" in response.json()["detail"]


def test_describe_image_source_keeps_logs_compact():
    """Board albums feed thousands of explicit file paths into indexing;
    log lines must summarize them, not dump the whole list.

    Expectations are built from Path/str round-trips rather than literals so
    the test holds on Windows, where str(Path(...)) uses backslashes.
    """
    from photomap.backend.embeddings import describe_image_source

    # Single directory and short lists print verbatim (native separators).
    vacation = Path("/photos/vacation")
    assert describe_image_source(vacation) == str(vacation)
    short = [Path("/photos/a"), Path("/photos/b")]
    assert describe_image_source(short) == f"{short[0]}, {short[1]}"

    # Long explicit lists collapse to a count + common parent.
    many = [Path(f"/root/outputs/images/{i:04d}.png") for i in range(3666)]
    description = describe_image_source(many)
    assert description == f"3666 explicit paths under {Path('/root/outputs/images')}"
    assert len(description) < 120


def test_first_update_failure_surfaces_error_without_prior_run(
    client, board_album, monkeypatch
):
    """A failure before scanning starts (InvokeAI unreachable) must produce a
    visible ERROR even when the tracker has no entry from an earlier run —
    e.g. the first update after a server restart. set_error used to drop the
    message then, leaving the UI stuck on "No operation in progress"."""
    from photomap.backend.progress import progress_tracker

    _build_index(client)
    progress_tracker.remove_progress(ALBUM_KEY)  # simulate a fresh server

    async def broken_fetch(base_url, board_ids, username, password):
        raise HTTPException(status_code=502, detail="connection refused")

    monkeypatch.setattr(invokeai_client, "fetch_board_image_names", broken_fetch)

    response = client.post("/update_index_async", json={"album_key": ALBUM_KEY})
    assert response.status_code == 202
    progress = _poll_until(client, ALBUM_KEY, {"completed", "error"}, timeout=10)
    assert progress["status"] == "error"
    assert "InvokeAI" in progress["error_message"]
