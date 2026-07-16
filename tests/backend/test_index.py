import shutil
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from fixtures import build_index, count_test_images

from photomap.backend.config import get_config_manager

# Import the cache function directly so we can inspect it
from photomap.backend.embeddings import Embeddings, _open_npz_file

TEST_IMAGE_COUNT = count_test_images()


def _save_noise_jpeg(path, width, height, seed=0):
    """Random-noise JPEG: compresses poorly, so even smallish dimensions stay
    above the gate's byte-size reject floor. Solid-color images do NOT — a
    300x300 single-color JPEG is ~3 KB and gets floor-rejected regardless of
    its pixel dimensions, which is exactly what the floor is for."""
    from PIL import Image

    rng = np.random.default_rng(seed)
    arr = rng.integers(0, 256, (height, width, 3), dtype=np.uint8)
    Image.fromarray(arr).save(path)


def test_index_creation(
    client: TestClient, new_album: dict, monkeypatch: pytest.MonkeyPatch
):
    """Test the ability to create indexes."""
    build_index(client, new_album)
    # Check that the index exists
    response = client.get(f"/index_exists/{new_album['key']}")
    assert response.status_code == 200
    exists = response.json().get("exists")
    assert exists is True

    # Check that we can get metadata for the index
    response = client.get(f"/index_metadata/{new_album['key']}")
    assert response.status_code == 200
    metadata = response.json()
    assert (
        metadata["filename_count"] == TEST_IMAGE_COUNT
    )  # Assuming 9 images in the test
    assert metadata["embeddings_path"] is not None
    assert metadata["last_modified"] is not None


# test that we can delete an image
def test_delete_image(
    client: TestClient, new_album: dict, monkeypatch: pytest.MonkeyPatch
):
    """Test the ability to delete an image."""
    build_index(client, new_album)

    album_key = new_album["key"]

    # === DEBUG: Check cache state before deletion ===
    print("\n=== BEFORE DELETION ===")
    print(f"Cache info: {_open_npz_file.cache_info()}")

    # Fetch the first slide, check its index
    response = client.get(f"/retrieve_image/{album_key}/0")
    data = response.json()
    assert data.get("index") == 0

    # Get the filename
    filename_to_delete = data.get("filename")
    assert filename_to_delete is not None

    print("\n=== ABOUT TO DELETE ===")
    print(f"Cache info: {_open_npz_file.cache_info()}")

    # Delete the image. We force ``move_to_trash=False`` so the test exercises
    # the unlink code path deterministically — the send2trash path depends on
    # a writable freedesktop trash dir on the temp file's mount, which isn't
    # guaranteed in CI or on dev machines where /tmp shares the root mount.
    response = client.delete(
        f"/delete_image/{album_key}/0", params={"move_to_trash": False}
    )
    assert response.status_code == 200
    assert response.json().get("success") is True

    print("\n=== AFTER DELETION ===")
    print(f"Cache info: {_open_npz_file.cache_info()}")

    # Force clear cache to verify it's not a cache issue
    _open_npz_file.cache_clear()
    print(f"Cache cleared manually: {_open_npz_file.cache_info()}")

    # Check that the index has been updated
    response = client.get(f"/index_metadata/{album_key}")
    assert response.status_code == 200
    metadata = response.json()

    print("\n=== METADATA CHECK ===")
    print(f"Expected count: {TEST_IMAGE_COUNT - 1}")
    print(f"Actual count: {metadata['filename_count']}")
    print(f"Embeddings path: {metadata['embeddings_path']}")
    print(f"Cache info after metadata call: {_open_npz_file.cache_info()}")

    # Let's also directly check the file on disk
    config = get_config_manager().get_album(album_key)
    index_path = Path(config.index)
    print("\n=== DIRECT FILE CHECK ===")
    print(f"Index path: {index_path}")
    print(f"Index path resolved: {index_path.resolve()}")

    # Load directly from disk without cache
    import numpy as np

    with np.load(index_path, allow_pickle=True) as data:
        disk_count = len(data["filenames"])
        print(f"Direct disk read count: {disk_count}")
        # The rewrite must keep the encoder stamp. Losing it makes readers
        # fall back to LEGACY_ENCODER_SPEC and every subsequent search fail
        # with EmbeddingCacheMismatch for albums on a non-legacy encoder.
        assert "model_id" in data.files, "deletion rewrite dropped model_id"
        assert str(data["model_id"]) == new_album["encoder_spec"]

    assert (
        metadata["filename_count"] == TEST_IMAGE_COUNT - 1
    )  # One less image after deletion

    directory = Path(new_album["image_paths"][0])
    assert not Path(
        directory, filename_to_delete
    ).exists(), "Image file should be deleted"


def test_npz_rewrites_preserve_non_per_image_keys(tmp_path: Path):
    """``remove_image_from_embeddings`` and ``update_image_path`` rewrite the
    whole ``.npz``; they must carry over ``model_id``, ``embedding_dim``, and
    any key added in the future, not just the four per-image arrays. Dropping
    ``model_id`` made the next reader fall back to the legacy encoder spec, so
    every search on a non-legacy album failed with ``EmbeddingCacheMismatch``
    after a single deletion."""
    encoder_spec = "open-clip:ViT-L-14/dfn2b_s39b"
    npz_path = tmp_path / "embeddings.npz"
    np.savez(
        npz_path,
        embeddings=np.eye(3, dtype=np.float32),
        filenames=np.array([str(tmp_path / f"{name}.jpg") for name in "abc"]),
        modification_times=np.array([1.0, 2.0, 3.0]),
        metadata=np.array([{}, {}, {}], dtype=object),
        model_id=np.array(encoder_spec),
        embedding_dim=np.array(3),
        future_key=np.array("still here"),
    )
    emb = Embeddings(embeddings_path=npz_path, encoder_spec=encoder_spec)

    emb.remove_image_from_embeddings(0)
    with np.load(npz_path, allow_pickle=True) as data:
        assert len(data["filenames"]) == 2
        assert str(data["model_id"]) == encoder_spec
        assert int(data["embedding_dim"]) == 3
        assert str(data["future_key"]) == "still here"

    emb.update_image_path(0, tmp_path / "renamed.jpg")
    with np.load(npz_path, allow_pickle=True) as data:
        assert str(tmp_path / "renamed.jpg") in data["filenames"]
        assert str(data["model_id"]) == encoder_spec
        assert int(data["embedding_dim"]) == 3
        assert str(data["future_key"]) == "still here"

    _open_npz_file.cache_clear()


# test that we can move images
def test_move_images(
    client: TestClient, new_album: dict, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """Test the ability to move images to a different directory."""
    build_index(client, new_album)

    album_key = new_album["key"]

    # Get the first image path
    response = client.get(f"/retrieve_image/{album_key}/0")
    data = response.json()
    assert data.get("index") == 0
    original_filename = data.get("filename")
    assert original_filename is not None

    # Create a target directory
    target_dir = tmp_path / "target_folder"
    target_dir.mkdir()

    # Move the first image
    response = client.post(
        f"/move_images/{album_key}",
        json={"indices": [0], "target_directory": str(target_dir)},
    )
    assert response.status_code == 200
    result = response.json()
    assert result.get("success") is True
    assert result.get("moved_count") == 1
    assert original_filename in result.get("moved_files", [])

    # Check that the file exists in the new location
    new_path = target_dir / original_filename
    assert new_path.exists(), "Image should exist in target directory"

    # Check that the file no longer exists in the old location
    old_path = Path(new_album["image_paths"][0]) / original_filename
    assert not old_path.exists(), "Image should not exist in original directory"

    # Verify the image can still be retrieved with updated path
    response = client.get(f"/retrieve_image/{album_key}/0")
    data = response.json()
    # Check that the filepath has been updated to the new location
    assert new_path.as_posix() in data.get("filepath", "")


def test_move_images_to_same_folder(
    client: TestClient, new_album: dict, monkeypatch: pytest.MonkeyPatch
):
    """Test moving images to the same folder they're already in."""
    build_index(client, new_album)

    album_key = new_album["key"]

    # Get the original directory
    response = client.get(f"/image_path/{album_key}/0")
    assert response.status_code == 200
    image_path = response.text
    original_dir = Path(image_path).parent

    # Try to move to the same directory
    response = client.post(
        f"/move_images/{album_key}",
        json={"indices": [0], "target_directory": str(original_dir)},
    )
    assert response.status_code == 200
    result = response.json()
    assert result.get("same_folder_count") == 1


def test_move_images_nonexistent_directory(
    client: TestClient, new_album: dict, monkeypatch: pytest.MonkeyPatch
):
    """Test moving images to a non-existent directory."""
    build_index(client, new_album)

    album_key = new_album["key"]

    # Try to move to a non-existent directory
    response = client.post(
        f"/move_images/{album_key}",
        json={"indices": [0], "target_directory": "/nonexistent/directory"},
    )
    assert response.status_code == 400
    assert "does not exist" in response.json().get("detail", "").lower()


def test_move_images_file_exists(
    client: TestClient, new_album: dict, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """Test moving images when a file with the same name exists in target."""
    build_index(client, new_album)

    album_key = new_album["key"]

    # Get the first image filename
    response = client.get(f"/retrieve_image/{album_key}/0")
    data = response.json()
    original_filename = data.get("filename")

    # Create a target directory with a file of the same name
    target_dir = tmp_path / "target_folder"
    target_dir.mkdir()
    existing_file = target_dir / original_filename
    existing_file.write_text("existing content")

    # Try to move the image
    response = client.post(
        f"/move_images/{album_key}",
        json={"indices": [0], "target_directory": str(target_dir)},
    )
    assert response.status_code == 200
    result = response.json()
    assert result.get("error_count") == 1
    assert any("already exists" in error for error in result.get("errors", []))


def test_copy_images(
    client: TestClient, new_album: dict, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """Test the ability to copy images to a different directory."""
    build_index(client, new_album)

    album_key = new_album["key"]

    # Get the first image path
    response = client.get(f"/retrieve_image/{album_key}/0")
    data = response.json()
    assert data.get("index") == 0
    original_filename = data.get("filename")
    assert original_filename is not None

    # Get the original file path
    response = client.get(f"/image_path/{album_key}/0")
    assert response.status_code == 200
    original_path = Path(response.text)
    assert original_path.exists(), "Original image should exist before copy"

    # Create a target directory
    target_dir = tmp_path / "export_folder"
    target_dir.mkdir()

    # Copy the first image
    response = client.post(
        f"/copy_images/{album_key}",
        json={"indices": [0], "target_directory": str(target_dir)},
    )
    assert response.status_code == 200
    result = response.json()
    assert result.get("success") is True
    assert result.get("copied_count") == 1
    assert original_filename in result.get("copied_files", [])

    # Check that the file exists in the new location
    new_path = target_dir / original_filename
    assert new_path.exists(), "Image should exist in target directory"

    # Check that the file still exists in the old location (copy, not move)
    assert original_path.exists(), "Image should still exist in original directory"

    # Verify the original image is still accessible
    response = client.get(f"/retrieve_image/{album_key}/0")
    data = response.json()
    assert data.get("index") == 0


def test_copy_images_file_exists(
    client: TestClient, new_album: dict, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """Test copying images when file already exists in target directory."""
    build_index(client, new_album)

    album_key = new_album["key"]

    # Get the first image
    response = client.get(f"/retrieve_image/{album_key}/0")
    data = response.json()
    original_filename = data.get("filename")

    # Get the original file path
    response = client.get(f"/image_path/{album_key}/0")
    original_path = Path(response.text)

    # Create a target directory with a file of the same name
    target_dir = tmp_path / "export_folder"
    target_dir.mkdir()

    # Copy the file manually to simulate it already existing
    shutil.copy2(original_path, target_dir / original_filename)

    # Try to copy the image (should fail)
    response = client.post(
        f"/copy_images/{album_key}",
        json={"indices": [0], "target_directory": str(target_dir)},
    )
    assert response.status_code == 200
    result = response.json()
    assert result.get("error_count") == 1
    assert any("already exists" in error for error in result.get("errors", []))


def test_create_directory(client: TestClient, tmp_path: Path):
    """Test the ability to create a new directory."""
    # Create a test directory
    test_dir = tmp_path / "test_parent"
    test_dir.mkdir()

    # Test creating a new directory
    response = client.post(
        "/filetree/create_directory",
        json={"parent_path": str(test_dir), "directory_name": "new_folder"},
    )
    assert response.status_code == 200
    result = response.json()
    assert result.get("success") is True
    assert result.get("name") == "new_folder"

    # Verify the directory was created
    new_dir = test_dir / "new_folder"
    assert new_dir.exists()
    assert new_dir.is_dir()


def test_create_directory_invalid_name(client: TestClient, tmp_path: Path):
    """Test creating a directory with invalid name."""
    test_dir = tmp_path / "test_parent"
    test_dir.mkdir()

    # Test with invalid character (slash)
    response = client.post(
        "/filetree/create_directory",
        json={"parent_path": str(test_dir), "directory_name": "invalid/name"},
    )
    assert response.status_code == 400
    assert "invalid characters" in response.json().get("detail", "").lower()


def test_create_directory_already_exists(client: TestClient, tmp_path: Path):
    """Test creating a directory that already exists."""
    test_dir = tmp_path / "test_parent"
    test_dir.mkdir()
    existing_dir = test_dir / "existing"
    existing_dir.mkdir()

    # Try to create the same directory again
    response = client.post(
        "/filetree/create_directory",
        json={"parent_path": str(test_dir), "directory_name": "existing"},
    )
    assert response.status_code == 409
    assert "already exists" in response.json().get("detail", "").lower()


class _DeterministicEncoder:
    """Stand-in encoder that produces deterministic embeddings per image.

    Returns an embedding that uniquely identifies the input image (mean pixel
    value of the resized RGB), so we can verify that parallel decoding still
    pairs the right embedding with the right input path.
    """

    model_id = "stub:deterministic"
    embedding_dim = 4
    device = "cpu"

    def encode_images(self, images):
        out = np.zeros((len(images), self.embedding_dim), dtype=np.float32)
        for i, img in enumerate(images):
            small = img.resize((8, 8))
            arr = np.asarray(small, dtype=np.float32)
            out[i, 0] = arr[..., 0].mean()
            out[i, 1] = arr[..., 1].mean()
            out[i, 2] = arr[..., 2].mean()
            out[i, 3] = float(arr.size)
        return out

    def encode_text(self, texts):
        return np.zeros((len(texts), self.embedding_dim), dtype=np.float32)

    def close(self):
        pass


def test_parallel_workers_preserve_order(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Parallel CPU loaders must yield the same per-path embedding as the serial path.

    Loading runs concurrently in worker threads; the consumer is responsible for
    re-aligning futures with their submission order before each batch is sent
    to the encoder. This test guards that alignment.
    """
    # Use the bundled test images and replicate them so we exercise multiple
    # batches and have enough work for parallelism to actually shuffle timing.
    src_images = sorted((Path(__file__).parent / "test_images").iterdir())
    work_dir = tmp_path / "images"
    work_dir.mkdir()
    image_paths: list[Path] = []
    for repeat in range(4):
        for src in src_images:
            dst = work_dir / f"{repeat:02d}_{src.name}"
            shutil.copy(src, dst)
            image_paths.append(dst)

    emb = Embeddings(embeddings_path=tmp_path / "ignored.npz")

    # Skip model loading and UMAP — we're testing the parallel pipeline,
    # not the encoder backend or dimensionality reduction.
    monkeypatch.setattr(Embeddings, "_build_encoder", lambda self: _DeterministicEncoder())
    monkeypatch.setattr(
        Embeddings,
        "create_umap_index",
        lambda self, embeddings: np.zeros((embeddings.shape[0], 2), dtype=np.float32),
    )

    serial = emb._process_images_batch(image_paths, batch_size=4, num_workers=1)
    parallel = emb._process_images_batch(image_paths, batch_size=4, num_workers=4)

    assert list(serial.filenames) == list(parallel.filenames)
    assert list(serial.filenames) == [p.resolve().as_posix() for p in image_paths]
    np.testing.assert_array_equal(serial.embeddings, parallel.embeddings)
    np.testing.assert_array_equal(
        serial.modification_times, parallel.modification_times
    )
    assert serial.bad_files == parallel.bad_files == []


def test_min_image_dimension_filters_small_images(tmp_path):
    """Files whose pixel dimensions are below ``min_image_dimension`` must
    be silently dropped during the directory scan; larger files are kept.
    Mirrors the original bug where a hard-coded 100KB byte-size filter was
    silently dropping ~25% of a real user's photo library.
    """

    img_dir = tmp_path / "imgs"
    img_dir.mkdir()
    # 100x100 — below the default 256 threshold; should be skipped.
    _save_noise_jpeg(img_dir / "tiny.jpg", 100, 100)
    # 200x300 — height passes 256 but width does not; should be skipped.
    _save_noise_jpeg(img_dir / "narrow.jpg", 200, 300)
    # 300x300 — both dimensions pass; should be kept.
    _save_noise_jpeg(img_dir / "ok.jpg", 300, 300)
    # 256x256 — exactly on the boundary; >= passes; should be kept.
    _save_noise_jpeg(img_dir / "exact.jpg", 256, 256)
    # Non-image extension, should never get to the dimension check.
    (img_dir / "notes.txt").write_text("not an image")

    emb = Embeddings(embeddings_path=tmp_path / "ignored.npz")
    files = emb.get_image_files_from_directory(img_dir)
    names = sorted(Path(p).name for p in files)
    assert names == ["exact.jpg", "ok.jpg"], (
        f"only 256+ images should be indexed, got {names}"
    )

    # Lowering the threshold makes the smaller ones eligible too. The byte
    # floor is disabled here to exercise the pixel gate in isolation — the
    # small noise JPEGs sit below the default 8 KB floor.
    emb_low = Embeddings(
        embeddings_path=tmp_path / "ignored.npz",
        min_image_dimension=100,
        min_image_bytes=0,
    )
    names_low = sorted(Path(p).name for p in emb_low.get_image_files_from_directory(img_dir))
    assert names_low == ["exact.jpg", "narrow.jpg", "ok.jpg", "tiny.jpg"]


def test_dimension_gate_size_shortcircuit(tmp_path):
    """Files over DIMENSION_PROBE_MAX_BYTES pass the gate on byte size alone,
    without the per-file header open. Proven with junk bytes PIL can't parse:
    the big file passes (never opened), the small one is probed and dropped.
    """
    from photomap.backend.embeddings import DIMENSION_PROBE_MAX_BYTES

    img_dir = tmp_path / "imgs"
    img_dir.mkdir()
    (img_dir / "big_junk.jpg").write_bytes(b"x" * (DIMENSION_PROBE_MAX_BYTES + 1))
    (img_dir / "small_junk.jpg").write_bytes(b"x" * 1024)

    emb = Embeddings(embeddings_path=tmp_path / "ignored.npz")
    names = [Path(p).name for p in emb.get_image_files_from_directory(img_dir)]
    assert names == ["big_junk.jpg"]


def test_update_scan_probes_only_new_files(tmp_path, monkeypatch):
    """The update-path diff must dimension-probe only files that are not
    already in the index — re-probing the whole library on every update was
    the dominant scan cost.
    """

    img_dir = tmp_path / "imgs"
    img_dir.mkdir()
    for name in ["a.jpg", "b.jpg", "c.jpg", "d.jpg"]:
        _save_noise_jpeg(img_dir / name, 300, 300)
    # A new file that must be probed and rejected as too small.
    _save_noise_jpeg(img_dir / "new_tiny.jpg", 100, 100)

    # a-c are already indexed (stored as resolved posix strings, matching
    # what _process_images_batch writes); d and new_tiny are new.
    existing = np.array(
        [(img_dir / n).resolve().as_posix() for n in ["a.jpg", "b.jpg", "c.jpg"]]
    )

    probed: list[str] = []
    original_gate = Embeddings._passes_dimension_gate

    def spy(self, path, st=None):
        probed.append(path.name)
        return original_gate(self, path, st)

    monkeypatch.setattr(Embeddings, "_passes_dimension_gate", spy)

    emb = Embeddings(embeddings_path=tmp_path / "ignored.npz")
    new_paths, missing_paths = emb._get_new_and_missing_images(img_dir, existing)

    assert sorted(probed) == ["d.jpg", "new_tiny.jpg"]
    assert {p.name for p in new_paths} == {"d.jpg"}
    assert missing_paths == set()


def _make_probe_spy(monkeypatch):
    """Monkeypatch _passes_dimension_gate to record which files get probed."""
    probed: list[str] = []
    original_gate = Embeddings._passes_dimension_gate

    def spy(self, path, st=None):
        probed.append(path.name)
        return original_gate(self, path, st)

    monkeypatch.setattr(Embeddings, "_passes_dimension_gate", spy)
    return probed


def test_scan_reject_cache_skips_reprobing(tmp_path, monkeypatch):
    """A file the gate rejected is remembered (with size/mtime) in the
    scan-reject cache; the next update dismisses it on the stat alone
    instead of re-opening it.
    """

    from photomap.backend.embeddings import SCAN_REJECTS_FILENAME

    img_dir = tmp_path / "imgs"
    img_dir.mkdir()
    _save_noise_jpeg(img_dir / "ok.jpg", 300, 300)
    _save_noise_jpeg(img_dir / "tiny.jpg", 100, 100)
    existing = np.array([(img_dir / "ok.jpg").resolve().as_posix()])

    emb = Embeddings(embeddings_path=tmp_path / "idx" / "embeddings.npz")

    # First update: tiny.jpg is new, gets probed, is rejected and cached.
    new1, _ = emb._get_new_and_missing_images(img_dir, existing)
    assert new1 == set()
    assert (tmp_path / "idx" / SCAN_REJECTS_FILENAME).exists()

    # Second update: nothing gets probed at all.
    probed = _make_probe_spy(monkeypatch)
    new2, _ = emb._get_new_and_missing_images(img_dir, existing)
    assert new2 == set()
    assert probed == []


def test_scan_reject_cache_revalidates_changed_files(tmp_path, monkeypatch):
    """A cached rejection is keyed to size/mtime: replacing the file with a
    large-enough image must be noticed and the file indexed."""

    img_dir = tmp_path / "imgs"
    img_dir.mkdir()
    _save_noise_jpeg(img_dir / "photo.jpg", 100, 100)
    existing = np.array([])

    emb = Embeddings(embeddings_path=tmp_path / "idx" / "embeddings.npz")
    new1, _ = emb._get_new_and_missing_images(img_dir, existing)
    assert new1 == set()

    # Same name, new content (different size and mtime), now big enough.
    _save_noise_jpeg(img_dir / "photo.jpg", 400, 400)

    probed = _make_probe_spy(monkeypatch)
    new2, _ = emb._get_new_and_missing_images(img_dir, existing)
    assert probed == ["photo.jpg"]
    assert {p.name for p in new2} == {"photo.jpg"}


def test_scan_reject_cache_invalidated_by_min_dim_change(tmp_path):
    """The cache memoizes verdicts for one min_image_dimension; changing the
    threshold must discard it rather than keep stale rejections."""

    img_dir = tmp_path / "imgs"
    img_dir.mkdir()
    _save_noise_jpeg(img_dir / "small.jpg", 100, 100)
    existing = np.array([])
    index_path = tmp_path / "idx" / "embeddings.npz"

    # Byte floor off in both instances so the pixel-gate change is the only
    # variable this test exercises.
    emb = Embeddings(embeddings_path=index_path, min_image_bytes=0)  # 256px gate
    new1, _ = emb._get_new_and_missing_images(img_dir, existing)
    assert new1 == set()

    emb_low = Embeddings(
        embeddings_path=index_path, min_image_dimension=50, min_image_bytes=0
    )
    new2, _ = emb_low._get_new_and_missing_images(img_dir, existing)
    assert {p.name for p in new2} == {"small.jpg"}


def test_thumbnail_dirs_pruned_from_traversal(tmp_path):
    """Hidden directories and thumbnail-cache directories (and
    photomap_index) are pruned from the walk entirely — their contents are
    never candidates, gated or not."""

    img_dir = tmp_path / "imgs"
    for sub in ["@eaDir", ".thumbnails", ".@__thumb", "__MACOSX", "photomap_index", "vacation"]:
        (img_dir / sub).mkdir(parents=True)
        _save_noise_jpeg(img_dir / sub / "pic.jpg", 300, 300)
    # Nested hidden caches (the Shotwell case): a 360px thumb passes both
    # gates, so only the hidden-dir pruning keeps it out of the index.
    shotwell = img_dir / ".shotwell" / "thumbs" / "thumbs360"
    shotwell.mkdir(parents=True)
    _save_noise_jpeg(shotwell / "thumb0000000000004edd.jpg", 360, 360)
    _save_noise_jpeg(img_dir / "top.jpg", 300, 300)

    emb = Embeddings(embeddings_path=tmp_path / "ignored.npz")
    # Gated and ungated traversals must prune identically.
    for gate in (True, False):
        found = {
            p.relative_to(img_dir.resolve()).as_posix()
            for p in emb.get_image_files_from_directory(img_dir, apply_dimension_gate=gate)
        }
        assert found == {"top.jpg", "vacation/pic.jpg"}


def test_check_progress_callback_reports_gate_progress(tmp_path):
    """The gate pass drives a (checked, total) progress callback, ending on
    (total, total) so the UI bar completes."""

    img_dir = tmp_path / "imgs"
    img_dir.mkdir()
    for i in range(5):
        _save_noise_jpeg(img_dir / f"p{i}.jpg", 300, 300)
    existing = np.array([])

    calls: list[tuple[int, int]] = []
    emb = Embeddings(embeddings_path=tmp_path / "idx" / "embeddings.npz")
    new, _ = emb._get_new_and_missing_images(
        img_dir, existing, check_progress_callback=lambda checked, total: calls.append((checked, total))
    )

    assert len(new) == 5
    assert calls[-1] == (5, 5)


def test_dimension_gate_byte_reject_floor(tmp_path, monkeypatch):
    """Files under the album's min_image_bytes are rejected without a header
    open; the floor is an independent per-album setting that can be lowered
    or disabled (0) for libraries with legitimately small photos."""
    from PIL import Image

    from photomap.backend import embeddings as embeddings_module
    from photomap.backend.embeddings import DIMENSION_REJECT_MIN_BYTES

    img_dir = tmp_path / "imgs"
    img_dir.mkdir()
    # A solid-color 300x300 JPEG: passes the pixel gate but compresses far
    # below the byte floor — the accepted ~0.15% false-negative case.
    Image.new("RGB", (300, 300), color="red").save(img_dir / "solid.jpg")
    solid_size = (img_dir / "solid.jpg").stat().st_size
    assert solid_size < DIMENSION_REJECT_MIN_BYTES, "premise: solid jpg must be sub-floor"

    opens: list[str] = []
    real_open = embeddings_module.Image.open

    def counting_open(fp, *args, **kwargs):
        opens.append(str(fp))
        return real_open(fp, *args, **kwargs)

    monkeypatch.setattr(embeddings_module.Image, "open", counting_open)

    # Default 8 KB floor: rejected on the stat alone — no open.
    emb = Embeddings(embeddings_path=tmp_path / "ignored.npz")
    assert emb.get_image_files_from_directory(img_dir) == []
    assert opens == []

    # Lowered floor (1 kb): the file is probed and kept.
    emb_low_floor = Embeddings(
        embeddings_path=tmp_path / "ignored.npz", min_image_bytes=1024
    )
    found = emb_low_floor.get_image_files_from_directory(img_dir)
    assert [Path(f).name for f in found] == ["solid.jpg"]
    assert len(opens) == 1

    # Floor disabled entirely (0): same outcome via the probe.
    emb_no_floor = Embeddings(
        embeddings_path=tmp_path / "ignored.npz", min_image_bytes=0
    )
    found = emb_no_floor.get_image_files_from_directory(img_dir)
    assert [Path(f).name for f in found] == ["solid.jpg"]
    assert len(opens) == 2


def test_index_metadata_reflects_last_update_operation(client, new_album):
    """The "Index updated <when>" timestamp must advance after every
    successful update operation, including a no-change one — the .npz is
    deliberately not rewritten then, so its mtime alone would make a
    freshly-refreshed album look stale."""
    import time

    build_index(client, new_album)
    key = new_album["key"]
    meta1 = client.get(f"/index_metadata/{key}").json()

    time.sleep(0.05)
    build_index(client, new_album)  # nothing new — the noop update path
    meta2 = client.get(f"/index_metadata/{key}").json()

    assert meta2["filename_count"] == meta1["filename_count"]
    assert meta2["last_modified"] > meta1["last_modified"]


def test_update_endpoint_registers_progress_before_task_runs(
    client, new_album, monkeypatch
):
    """The update endpoint must create the progress entry itself: the first
    poll otherwise races the background task (board resolution and loading a
    big existing .npz happen before the task's own start_operation) and
    paints "No operation in progress" — and if the task dies inside that
    window, the run looks idle forever."""
    from photomap.backend.progress import progress_tracker
    from photomap.backend.routers import index as index_router

    key = new_album["key"]
    progress_tracker.remove_progress(key)

    async def frozen_task(album_key, album_config):
        return None  # never reaches its own start_operation

    monkeypatch.setattr(index_router, "_update_index_background_async", frozen_task)

    try:
        response = client.post("/update_index_async", json={"album_key": key})
        assert response.status_code == 202

        progress = client.get(f"/index_progress/{key}").json()
        assert progress["status"] == "scanning"
        assert progress["current_step"] == "Preparing index update..."
    finally:
        # The frozen task never completes; drop the entry so the shared
        # tracker can't 409 later tests that reuse this album key.
        progress_tracker.remove_progress(key)
