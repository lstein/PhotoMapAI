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
        assert response.headers["content-type"] == "image/png"
    with Image.open(BytesIO(response.content)) as im:
        assert im.size == (300, 300)


def test_original_flag_serves_the_untouched_file(client, format_album, tmp_path):
    """Downloads ask for ``?original=1`` and must get the TIFF itself, not the
    PNG the viewer is shown."""
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
