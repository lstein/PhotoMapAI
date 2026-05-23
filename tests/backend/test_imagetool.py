"""Smoke tests for :mod:`photomap.backend.imagetool` CLI entry points.

These ensure each script can dispatch through ``main()`` and that the
underlying ``Embeddings`` methods are called with kwarg names that
actually exist. Regression coverage for the long-standing
``query_image_path=`` typo in ``do_search`` that raised ``TypeError`` on
every first call.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from photomap.backend import imagetool

# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def fake_npz(tmp_path: Path) -> Path:
    """Minimal ``.npz`` whose existence is enough for ``Embeddings(...)`` to
    construct successfully. The CLI never reads from it because we stub the
    search method, but ``do_update_images`` checks ``os.path.exists`` first."""
    path = tmp_path / "fake.npz"
    np.savez(
        path,
        embeddings=np.zeros((0, 16), dtype=np.float32),
        filenames=np.array([], dtype=object),
        modification_times=np.array([], dtype=np.float64),
        metadata=np.array([], dtype=object),
        model_id=np.array("fake:test-encoder"),
        embedding_dim=np.array(16),
    )
    return path


@pytest.fixture
def fake_query_image(tmp_path: Path) -> Path:
    """Tiny PNG so ``Image.open(...)`` inside ``do_search`` works."""
    path = tmp_path / "query.png"
    Image.new("RGB", (8, 8), color=(127, 64, 32)).save(path)
    return path


# ---------------------------------------------------------------------------
# do_search — regression test for the query_image_path typo
# ---------------------------------------------------------------------------


class TestDoSearch:
    def test_passes_pil_image_via_query_image_data_kwarg(
        self, monkeypatch, fake_npz, fake_query_image, capsys
    ):
        """The old CLI passed ``query_image_path=Path(...)`` which raised
        ``TypeError: got an unexpected keyword argument 'query_image_path'``
        before ever reaching the encoder. The fix opens the file as a PIL
        Image and passes ``query_image_data=img``."""
        captured: dict[str, object] = {}

        def fake_search(self, *args, **kwargs):
            captured["args"] = args
            captured["kwargs"] = kwargs
            return [], []

        monkeypatch.setattr(
            "photomap.backend.embeddings.Embeddings.search_images_by_text_and_image",
            fake_search,
        )
        monkeypatch.setattr(
            sys, "argv", ["search_images", str(fake_query_image), "--embeddings", str(fake_npz)]
        )

        # Must not raise — that was the original bug.
        imagetool.do_search()

        # The new kwarg name landed; the broken one is gone.
        assert "query_image_data" in captured["kwargs"]
        assert "query_image_path" not in captured["kwargs"]
        # And the value is an actual PIL Image, not a Path.
        assert isinstance(captured["kwargs"]["query_image_data"], Image.Image)
        # ``top_k`` is also forwarded.
        assert captured["kwargs"].get("top_k") == 5

    def test_top_k_is_forwarded(
        self, monkeypatch, fake_npz, fake_query_image
    ):
        captured: dict[str, object] = {}

        def fake_search(self, *args, **kwargs):
            captured["kwargs"] = kwargs
            return [], []

        monkeypatch.setattr(
            "photomap.backend.embeddings.Embeddings.search_images_by_text_and_image",
            fake_search,
        )
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "search_images",
                str(fake_query_image),
                "--embeddings",
                str(fake_npz),
                "--top_k",
                "17",
            ],
        )

        imagetool.do_search()
        assert captured["kwargs"]["top_k"] == 17


# ---------------------------------------------------------------------------
# do_text_search — parallel coverage; same shape, different query type
# ---------------------------------------------------------------------------


class TestDoTextSearch:
    def test_passes_text_via_positive_query_kwarg(
        self, monkeypatch, fake_npz
    ):
        captured: dict[str, object] = {}

        def fake_search(self, *args, **kwargs):
            captured["kwargs"] = kwargs
            return [], []

        monkeypatch.setattr(
            "photomap.backend.embeddings.Embeddings.search_images_by_text_and_image",
            fake_search,
        )
        monkeypatch.setattr(
            sys,
            "argv",
            ["search_text", "a cat on a skateboard", "--embeddings", str(fake_npz)],
        )

        imagetool.do_text_search()
        assert captured["kwargs"].get("positive_query") == "a cat on a skateboard"
        assert captured["kwargs"].get("top_k") == 5


# ---------------------------------------------------------------------------
# main() dispatch — sys.argv[0] basename → handler routing
# ---------------------------------------------------------------------------


class TestMainDispatch:
    @pytest.mark.parametrize(
        "argv0,handler_name",
        [
            ("search_images", "do_search"),
            ("search_text", "do_text_search"),
            ("index_images", "do_index"),
            ("update_images", "do_update_images"),
            ("find_duplicate_images", "do_duplicate_search"),
            ("rebuild_cluster_labels", "do_rebuild_cluster_labels"),
        ],
    )
    def test_main_routes_by_basename(self, monkeypatch, argv0, handler_name):
        called: list[str] = []
        monkeypatch.setattr(
            imagetool, handler_name, lambda: called.append(handler_name)
        )
        monkeypatch.setattr(sys, "argv", [argv0])
        imagetool.main()
        assert called == [handler_name]
