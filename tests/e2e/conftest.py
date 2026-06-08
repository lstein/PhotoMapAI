"""Fixtures for the end-to-end (real browser) smoke tests.

These tests launch the actual PhotoMapAI server against a throwaway album and
drive it with a headless Chromium via Playwright. They exist to catch
integration regressions that the jsdom unit tests cannot — anything that lives
in the real interaction between our code and Swiper.js (autoplay, slide
buffering, transitions). The shuffle-slideshow freeze that motivated this
harness was exactly such a bug: it only reproduced in a real browser.

The album index is a *fake* ``.npz`` built at fixture time (random vectors,
real on-disk image paths) so the suite needs neither the CLIP model nor any
network — just the committed test images under ``tests/backend/test_images``.

E2E tests are opt-in: they only run when ``RUN_E2E=1`` is set (see
``pytest_collection_modifyitems``), so ``pytest tests`` stays fast and
browser-free for everyone else and in the default CI job.
"""

from __future__ import annotations

import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
TEST_IMAGES_DIR = REPO_ROOT / "tests" / "backend" / "test_images"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
EMBED_DIM = 512


def _collect_test_images() -> list[Path]:
    images = sorted(p for p in TEST_IMAGES_DIR.iterdir() if p.suffix.lower() in IMAGE_EXTS)
    if not images:
        raise RuntimeError(f"No test images found under {TEST_IMAGES_DIR}")
    return images


def _build_fake_index(image_paths: list[Path], out_npz: Path) -> None:
    """Write a minimal ``.npz`` matching Embeddings._save_embeddings's schema.

    The slideshow path never loads the encoder, so the embedding *values* are
    irrelevant — only the filenames (absolute, on-disk) and the image count
    matter. Built at runtime so the paths resolve on whatever machine runs the
    suite (the real index stores absolute paths and is therefore not portable
    as a committed fixture).
    """
    paths = [p.resolve() for p in image_paths]
    rng = np.random.default_rng(0)
    np.savez(
        out_npz,
        embeddings=rng.standard_normal((len(paths), EMBED_DIM)).astype("float32"),
        filenames=np.array([p.as_posix() for p in paths]),
        modification_times=np.array([p.stat().st_mtime for p in paths], dtype="float64"),
        metadata=np.array([{} for _ in paths], dtype=object),
        model_id=np.array("hf-hub:laion/CLIP-ViT-B-32-laion2B-s34B-b79K"),
        embedding_dim=np.array(EMBED_DIM),
    )


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for_http(base_url: str, timeout: float = 60.0) -> None:
    import urllib.error
    import urllib.request

    deadline = time.time() + timeout
    last_err: Exception | None = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(base_url, timeout=2) as resp:
                if resp.status == 200:
                    return
        except (urllib.error.URLError, OSError) as exc:  # not up yet
            last_err = exc
        time.sleep(0.4)
    raise RuntimeError(f"server at {base_url} did not become ready in {timeout}s (last: {last_err})")


@pytest.fixture(scope="session")
def e2e_server(tmp_path_factory: pytest.TempPathFactory) -> str:
    """Launch the real server against a throwaway one-album config; yield base URL."""
    workdir = tmp_path_factory.mktemp("e2e_album")
    index_path = workdir / "embeddings.npz"
    _build_fake_index(_collect_test_images(), index_path)

    config_path = workdir / "config.yaml"
    config_path.write_text(
        yaml.safe_dump(
            {
                "config_version": "1.0.0",
                "albums": {
                    "e2e": {
                        "name": "E2E Test Album",
                        "description": "throwaway album for e2e smoke tests",
                        "image_paths": [str(TEST_IMAGES_DIR)],
                        "index": str(index_path),
                        "umap_eps": 0.13,
                    }
                },
            }
        )
    )

    port = _free_port()
    base_url = f"http://127.0.0.1:{port}/"
    start_photomap = Path(sys.executable).with_name("start_photomap")

    env = {**os.environ, "PHOTOMAP_NO_BROWSER": "1"}
    proc = subprocess.Popen(
        [
            str(start_photomap),
            "--config", str(config_path),
            "--host", "127.0.0.1",
            "--port", str(port),
            "--no-browser",
            "--once",
        ],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    try:
        _wait_for_http(base_url)
        yield base_url
    finally:
        # Kill the whole process group; the server may spawn child workers.
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            proc.wait(timeout=5)


@pytest.fixture(scope="session")
def _playwright():
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        yield p


@pytest.fixture(scope="session")
def browser(_playwright):
    browser = _playwright.chromium.launch()
    try:
        yield browser
    finally:
        browser.close()


@pytest.fixture
def page(browser):
    context = browser.new_context()
    page = context.new_page()
    try:
        yield page
    finally:
        context.close()


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """Skip e2e tests unless RUN_E2E=1 — keeps the default suite fast/browser-free."""
    if os.environ.get("RUN_E2E") == "1":
        return
    skip = pytest.mark.skip(reason="e2e tests are opt-in; set RUN_E2E=1 to run them")
    for item in items:
        if "e2e" in item.keywords:
            item.add_marker(skip)
