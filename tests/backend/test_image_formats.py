"""Every suffix in ``IMAGE_EXTENSIONS`` must index and display.

Issue #364: ``.tif`` (the spelling scanners and Windows tools produce),
``.avif`` and ``.jfif`` were missing from the taxonomy, so an album of them
indexed as silently empty and the serving guard 403'd them.
"""

from __future__ import annotations

import subprocess
import sys
from io import BytesIO
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from photomap.backend.embeddings import Embeddings
from photomap.backend.media_types import BROWSER_CONVERTED_EXTENSIONS, IMAGE_EXTENSIONS

# The PIL format that writes each suffix. Keyed on IMAGE_EXTENSIONS itself (see
# the completeness test) so a suffix added later cannot skip these checks.
SAVE_FORMATS = {
    ".jpg": "JPEG",
    ".jpeg": "JPEG",
    ".jfif": "JPEG",
    ".png": "PNG",
    ".bmp": "BMP",
    ".gif": "GIF",
    ".webp": "WEBP",
    ".avif": "AVIF",
    ".tif": "TIFF",
    ".tiff": "TIFF",
    ".heif": "HEIF",
    ".heic": "HEIF",
}


def _write_image(path: Path, mode: str = "RGB", size: int = 300) -> None:
    import photomap.backend.media_types  # noqa: F401  (registers the HEIF writer)

    rng = np.random.default_rng(0)
    pixels = rng.integers(0, 256, (size, size, len(mode)), dtype=np.uint8)
    Image.fromarray(pixels, mode=mode).save(path, format=SAVE_FORMATS[path.suffix.lower()])


def test_every_image_extension_has_a_fixture_format():
    assert set(SAVE_FORMATS) == set(IMAGE_EXTENSIONS)


@pytest.mark.parametrize("suffix", sorted(IMAGE_EXTENSIONS))
def test_image_suffix_is_collected_by_the_walk(tmp_path, suffix):
    img_dir = tmp_path / "imgs"
    img_dir.mkdir()
    _write_image(img_dir / f"scan001{suffix}")
    # Upper-case too: Windows tools write SCAN001.TIF.
    _write_image(img_dir / f"scan002{suffix.upper()}")

    emb = Embeddings(embeddings_path=tmp_path / "ignored.npz", min_image_bytes=0)
    names = sorted(Path(p).name for p in emb.get_image_files_from_directory(img_dir))
    assert names == [f"scan001{suffix}", f"scan002{suffix.upper()}"]


def test_is_image_implies_pil_can_open_without_importing_embeddings(tmp_path):
    """``media_types`` is a leaf module; importing it alone must be enough to
    open everything it calls an image. HEIC used to open only because
    ``embeddings`` registered the plugin as an import-time side effect."""
    for suffix in IMAGE_EXTENSIONS:
        _write_image(tmp_path / f"probe{suffix}")
    script = (
        "import sys\n"
        "from pathlib import Path\n"
        "from PIL import Image\n"
        "from photomap.backend.media_types import is_image\n"
        "assert 'photomap.backend.embeddings' not in sys.modules\n"
        "for p in sorted(Path(sys.argv[1]).iterdir()):\n"
        "    assert is_image(p), p\n"
        "    with Image.open(p) as im:\n"
        "        im.load()\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", script, str(tmp_path)], capture_output=True, text=True, timeout=120
    )
    assert result.returncode == 0, result.stderr


@pytest.fixture
def format_album(client: TestClient, tmp_path):
    img_dir = tmp_path / "formats"
    img_dir.mkdir()
    for suffix in IMAGE_EXTENSIONS:
        _write_image(img_dir / f"img{suffix}")
    # A print-shop TIFF: PNG cannot store CMYK, so conversion must not 500.
    _write_image(img_dir / "cmyk.tif", mode="CMYK")
    response = client.post(
        "/add_album/",
        json={
            "key": "format_album",
            "name": "formats",
            "image_paths": [img_dir.as_posix()],
            "index": (tmp_path / "formats.npz").as_posix(),
            "umap_eps": 0.1,
            "description": "",
        },
    )
    assert response.status_code == 201, response.text
    yield
    client.delete("/delete_album/format_album")


@pytest.mark.parametrize("name", [f"img{s}" for s in sorted(IMAGE_EXTENSIONS)] + ["cmyk.tif"])
def test_image_suffix_is_served_in_a_browser_renderable_form(client, format_album, name):
    response = client.get(f"/images/format_album/{name}")
    assert response.status_code == 200, response.text
    if Path(name).suffix in BROWSER_CONVERTED_EXTENSIONS:
        assert response.headers["content-type"] == "image/jpeg"
    with Image.open(BytesIO(response.content)) as im:
        assert im.size == (300, 300)


def test_original_flag_serves_the_untouched_file(client, format_album, tmp_path):
    """Downloads ask for ``?original=1`` and must get the TIFF itself, not the
    JPEG the viewer is shown."""
    response = client.get("/images/format_album/cmyk.tif", params={"original": 1})
    assert response.status_code == 200
    assert response.content == (tmp_path / "formats" / "cmyk.tif").read_bytes()


@pytest.mark.parametrize(
    "make",
    [
        pytest.param(lambda: Image.new("I;16B", (8, 8), 40000), id="16-bit big-endian"),
        pytest.param(lambda: Image.new("I", (8, 8), 40000), id="32-bit int"),
        pytest.param(lambda: Image.new("F", (8, 8), 0.5), id="float in [0,1]"),
    ],
)
def test_deep_tiffs_are_not_clipped_to_a_blank_page(tmp_path, make):
    from photomap.backend.routers.search import _png_safe

    im = _png_safe(make())
    assert im.mode == "I;16"
    # 40000 and 0.5 are both mid-grey; a clipping convert gives 255 or 0.
    value = im.getpixel((0, 0))
    assert 30000 < value < 50000, value


# --- Issue #414: the display copy is downscaled and cached -------------------


@pytest.fixture
def encode_calls(monkeypatch):
    """Count the conversions /images/ actually performs."""
    from photomap.backend.routers import search

    calls: list[Path] = []
    real = search._encode_display_copy

    def counting(image_path):
        calls.append(Path(image_path))
        return real(image_path)

    monkeypatch.setattr(search, "_encode_display_copy", counting)
    return calls


def test_a_second_request_is_served_from_the_cache_with_a_304(client, format_album, encode_calls):
    first = client.get("/images/format_album/img.tif")
    assert first.status_code == 200
    etag = first.headers["etag"]
    assert len(encode_calls) == 1

    again = client.get("/images/format_album/img.tif")
    assert again.status_code == 200
    assert again.content == first.content
    assert again.headers["etag"] == etag

    revalidated = client.get("/images/format_album/img.tif", headers={"If-None-Match": etag})
    assert revalidated.status_code == 304
    assert revalidated.content == b""
    assert len(encode_calls) == 1


def test_touching_the_source_rebuilds_the_copy(client, format_album, encode_calls, tmp_path):
    import os

    assert client.get("/images/format_album/img.tif").status_code == 200
    source = tmp_path / "formats" / "img.tif"
    future = source.stat().st_mtime + 60
    os.utime(source, (future, future))
    assert client.get("/images/format_album/img.tif").status_code == 200
    assert len(encode_calls) == 2


def test_the_copy_is_capped_at_the_display_size(client, format_album, tmp_path):
    from photomap.backend.routers.search import _DISPLAY_MAX_EDGE

    Image.new("RGB", (_DISPLAY_MAX_EDGE * 2, 64), (10, 200, 30)).save(tmp_path / "formats" / "wide.tif")
    response = client.get("/images/format_album/wide.tif")
    assert response.status_code == 200
    with Image.open(BytesIO(response.content)) as im:
        assert im.size == (_DISPLAY_MAX_EDGE, 32)
    # The download still gets every pixel.
    original = client.get("/images/format_album/wide.tif", params={"original": 1})
    with Image.open(BytesIO(original.content)) as im:
        assert im.size == (_DISPLAY_MAX_EDGE * 2, 64)


def test_transparency_is_kept_as_webp_and_an_empty_alpha_is_not(client, format_album, tmp_path):
    img_dir = tmp_path / "formats"
    clear = Image.new("RGBA", (40, 40), (255, 0, 0, 255))
    clear.putpixel((0, 0), (0, 0, 0, 0))
    clear.save(img_dir / "alpha.tif")
    Image.new("RGBA", (40, 40), (255, 0, 0, 255)).save(img_dir / "opaque.tif")

    alpha = client.get("/images/format_album/alpha.tif")
    assert alpha.headers["content-type"] == "image/webp"
    with Image.open(BytesIO(alpha.content)) as im:
        assert im.mode == "RGBA"
        assert im.getpixel((0, 0))[3] == 0

    opaque = client.get("/images/format_album/opaque.tif")
    assert opaque.headers["content-type"] == "image/jpeg"


def test_a_16_bit_scan_is_not_clipped_in_the_jpeg(client, format_album, tmp_path):
    Image.new("I;16", (32, 32), 40000).save(tmp_path / "formats" / "deep.tif")
    response = client.get("/images/format_album/deep.tif")
    assert response.status_code == 200
    with Image.open(BytesIO(response.content)) as im:
        value = im.convert("L").getpixel((0, 0))
    assert 140 < value < 170, value  # 40000/65535 of full scale, not 255


def test_the_exif_orientation_is_applied(client, format_album, tmp_path):
    im = Image.new("RGB", (60, 20), (0, 0, 255))
    exif = im.getexif()
    exif[0x0112] = 6  # rotate 90 CW on display
    im.save(tmp_path / "formats" / "rotated.tif", exif=exif)
    response = client.get("/images/format_album/rotated.tif")
    with Image.open(BytesIO(response.content)) as shown:
        assert shown.size == (20, 60)


def test_an_unwritable_cache_still_serves_the_image(client, format_album, encode_calls, monkeypatch):
    from photomap.backend.routers import search

    def refuse(*a, **k):
        raise PermissionError("read-only index directory")

    monkeypatch.setattr(search.tempfile, "mkstemp", refuse)
    for _ in range(2):
        response = client.get("/images/format_album/img.tif")
        assert response.status_code == 200
        with Image.open(BytesIO(response.content)) as im:
            assert im.size == (300, 300)
    assert len(encode_calls) == 2


def test_concurrent_requests_convert_once(tmp_path, monkeypatch):
    import threading

    from photomap.backend.routers import search

    source = tmp_path / "scan.tif"
    Image.new("RGB", (50, 50), (1, 2, 3)).save(source)
    stem = tmp_path / "thumbnails" / "abc_display"

    calls = []
    release = threading.Event()
    real = search._encode_display_copy

    def slow(image_path):
        calls.append(image_path)
        release.wait(5)
        return real(image_path)

    monkeypatch.setattr(search, "_encode_display_copy", slow)
    results = []
    threads = [
        threading.Thread(target=lambda: results.append(search._display_copy(source, stem))) for _ in range(3)
    ]
    for t in threads:
        t.start()
    # Let every thread reach the lock before the first conversion finishes.
    deadline = threading.Event()
    deadline.wait(0.3)
    release.set()
    for t in threads:
        t.join(10)
    assert len(calls) == 1
    assert len(results) == 3 and len({r[0] for r in results}) == 1
    names = [p.name for p in stem.parent.iterdir()]
    assert len(names) == 1 and names[0].startswith("abc_display_") and names[0].endswith(".jpg"), names


def test_the_reindex_sweep_keeps_live_display_copies_only(client, format_album, tmp_path):
    from photomap.backend.thumbnail_cache import keep_hashes_for, prune, thumbnail_dir

    img_dir = tmp_path / "formats"
    for name in ("img.tif", "img.heic"):
        assert client.get(f"/images/format_album/{name}").status_code == 200
    tiles = thumbnail_dir(tmp_path / "formats.npz")
    assert len(list(tiles.glob("*_display_*.jpg"))) == 2

    # img.heic has since been deleted from the album.
    live = [str((img_dir / "img.tif").resolve())]
    removed = prune(tiles, keep_hashes_for(live, [str(img_dir)], lambda p: False))
    assert removed == 1
    remaining = list(tiles.glob("*_display_*.jpg"))
    assert len(remaining) == 1
    # And the survivor is the one the route still asks for.
    with_cache = client.get("/images/format_album/img.tif")
    assert with_cache.status_code == 200
    assert remaining[0].read_bytes() == with_cache.content


def _solid_tif(path: Path, color, mtime: float | None = None) -> None:
    import os

    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (40, 40), color).save(path)
    if mtime is not None:
        os.utime(path, (mtime, mtime))


def _shown_color(response):
    assert response.status_code == 200, response.text
    with Image.open(BytesIO(response.content)) as im:
        return im.convert("RGB").getpixel((20, 20))


def _add_album(client, key, root: Path, index: Path):
    response = client.post(
        "/add_album/",
        json={
            "key": key,
            "name": key,
            "image_paths": [root.as_posix()],
            "index": index.as_posix(),
            "umap_eps": 0.1,
            "description": "",
        },
    )
    assert response.status_code == 201, response.text


def test_a_source_replaced_with_an_older_mtime_is_reconverted(client, format_album, tmp_path):
    """``cp -p`` of an edited file, or a restore from backup."""
    target = tmp_path / "formats" / "swap.tif"
    _solid_tif(target, (255, 0, 0))
    assert _shown_color(client.get("/images/format_album/swap.tif"))[0] > 200
    _solid_tif(target, (0, 0, 255), mtime=target.stat().st_mtime - 3600)
    assert _shown_color(client.get("/images/format_album/swap.tif"))[2] > 200


def test_an_edit_during_conversion_is_not_cached_as_current(client, format_album, tmp_path, monkeypatch):
    import time

    from photomap.backend.routers import search

    target = tmp_path / "formats" / "race.tif"
    _solid_tif(target, (255, 0, 0), mtime=time.time() - 100)
    real = search._encode_display_copy

    def edited_meanwhile(image_path):
        result = real(image_path)  # decoded the red version...
        # ...then it was saved, before the copy was written.
        _solid_tif(target, (0, 0, 255), mtime=time.time() - 50)
        return result

    monkeypatch.setattr(search, "_encode_display_copy", edited_meanwhile)
    client.get("/images/format_album/race.tif")
    monkeypatch.setattr(search, "_encode_display_copy", real)
    assert _shown_color(client.get("/images/format_album/race.tif"))[2] > 200


def test_same_named_images_under_a_symlinked_root_do_not_share_a_copy(client, tmp_path):
    real = tmp_path / "real"
    _solid_tif(real / "a" / "scan.tif", (255, 0, 0))
    _solid_tif(real / "b" / "scan.tif", (0, 0, 255))
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)
    _add_album(client, "symlinked", link, tmp_path / "idx" / "embeddings.npz")
    try:
        assert _shown_color(client.get("/images/symlinked/a/scan.tif"))[0] > 200
        assert _shown_color(client.get("/images/symlinked/b/scan.tif"))[2] > 200
    finally:
        client.delete("/delete_album/symlinked")


def test_albums_sharing_an_index_directory_do_not_share_copies(client, tmp_path):
    _solid_tif(tmp_path / "ra" / "IMG_0001.tif", (255, 0, 0))
    _solid_tif(tmp_path / "rb" / "IMG_0001.tif", (0, 0, 255))
    _add_album(client, "side_a", tmp_path / "ra", tmp_path / "indexes" / "a.npz")
    _add_album(client, "side_b", tmp_path / "rb", tmp_path / "indexes" / "b.npz")
    try:
        assert _shown_color(client.get("/images/side_a/IMG_0001.tif"))[0] > 200
        assert _shown_color(client.get("/images/side_b/IMG_0001.tif"))[2] > 200
    finally:
        client.delete("/delete_album/side_a")
        client.delete("/delete_album/side_b")


def test_an_edit_leaves_one_copy_behind_not_two(client, format_album, tmp_path):
    from photomap.backend.thumbnail_cache import thumbnail_dir

    target = tmp_path / "formats" / "edited.tif"
    _solid_tif(target, (255, 0, 0))
    client.get("/images/format_album/edited.tif")
    _solid_tif(target, (0, 0, 255), mtime=target.stat().st_mtime + 5)
    client.get("/images/format_album/edited.tif")
    tiles = thumbnail_dir(tmp_path / "formats.npz")
    before = {p.name for p in tiles.glob("*_display_*")}
    client.get("/images/format_album/img.tif")
    assert len({p.name for p in tiles.glob("*_display_*")} - before) == 1
    assert len(before) == 1


def test_an_image_deleted_mid_conversion_leaves_no_copy(client, format_album, tmp_path, monkeypatch):
    from photomap.backend.routers import search
    from photomap.backend.thumbnail_cache import thumbnail_dir

    target = tmp_path / "formats" / "doomed.tif"
    _solid_tif(target, (255, 0, 0))
    real = search._encode_display_copy

    def deleted_meanwhile(image_path):
        result = real(image_path)
        target.unlink()
        return result

    monkeypatch.setattr(search, "_encode_display_copy", deleted_meanwhile)
    assert client.get("/images/format_album/doomed.tif").status_code == 200
    assert not list(thumbnail_dir(tmp_path / "formats.npz").glob("*_display*"))


def test_a_profile_is_dropped_when_the_mode_changes(tmp_path):
    from PIL import ImageCms

    from photomap.backend.routers.search import _display_safe

    im = Image.new("LA", (4, 4), (100, 255))
    im.info["icc_profile"] = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    out = _display_safe(im)
    assert out.mode == "RGBA"
    assert "icc_profile" not in out.info


def test_an_edit_before_decoding_is_not_filed_under_the_old_stamp(client, format_album, tmp_path, monkeypatch):
    """Otherwise restoring the original (``cp -p``, a backup) shows the edit."""
    import os

    from photomap.backend.routers import search

    target = tmp_path / "formats" / "restore.tif"
    _solid_tif(target, (255, 0, 0))
    original = target.stat()
    backup = tmp_path / "restore.bak"
    backup.write_bytes(target.read_bytes())
    real = search._encode_display_copy

    def edited_first(image_path):
        # Same size, as an uncompressed TIFF of fixed dimensions would be.
        _solid_tif(target, (0, 0, 255), mtime=original.st_mtime + 10)
        return real(image_path)

    monkeypatch.setattr(search, "_encode_display_copy", edited_first)
    client.get("/images/format_album/restore.tif")
    monkeypatch.setattr(search, "_encode_display_copy", real)

    target.write_bytes(backup.read_bytes())
    os.utime(target, ns=(original.st_atime_ns, original.st_mtime_ns))
    assert _shown_color(client.get("/images/format_album/restore.tif"))[0] > 200


def test_a_temporary_swept_mid_write_does_not_silence_later_warnings(tmp_path, monkeypatch, caplog):
    from photomap.backend.routers import search

    source = tmp_path / "scan.tif"
    Image.new("RGB", (10, 10)).save(source)
    stem = tmp_path / "thumbs" / ("0" * 32 + "_display_00000000")
    real_replace = search.os.replace

    def swept(src, dst):
        Path(src).unlink()
        return real_replace(src, dst)

    monkeypatch.setattr(search.os, "replace", swept)
    search._display_copy(source, stem)
    assert stem.parent not in search._unwritable_display_dirs
