"""Tests for the new-vs-missing path diff in
:class:`photomap.backend.embeddings.Embeddings`.

The diff used to use plain Path equality, which is always case-sensitive
regardless of the underlying filesystem. On case-insensitive filesystems
(Windows NTFS, macOS HFS+/APFS-CI) that meant the same image referenced
with different case in its filename — e.g. ``Photo.JPG`` in the .npz
cache and ``photo.jpg`` on disk — would be classified as both *new* and
*missing*, silently double-encoding the image and orphaning the cache
row. The fix funnels both sides through a casefolded posix-form key.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import numpy as np

from photomap.backend.embeddings import Embeddings

# ---------------------------------------------------------------------------
# _path_compare_key — direct unit test of the canonical-key derivation
# ---------------------------------------------------------------------------


class TestPathCompareKey:
    def test_same_case_unchanged(self):
        assert Embeddings._path_compare_key(Path("/a/b/c.jpg")) == "/a/b/c.jpg"

    def test_uppercase_extension_casefolds(self):
        assert Embeddings._path_compare_key(
            Path("/a/b/Photo.JPG")
        ) == "/a/b/photo.jpg"

    def test_mixed_case_path_casefolds(self):
        assert Embeddings._path_compare_key(
            Path("/Users/Alice/Photos/IMG_001.PNG")
        ) == "/users/alice/photos/img_001.png"

    def test_windows_style_path_normalised_to_posix(self):
        # ``PurePosixPath`` would round-trip ``\\`` unchanged. On Linux test
        # runners ``Path`` is a PosixPath, so a literal backslash stays as
        # a character in the basename — but the casefold still applies so
        # the comparison still works the way we need it to.
        assert Embeddings._path_compare_key(
            Path("C:/Users/Alice/Photo.JPG")
        ).endswith("photo.jpg")


# ---------------------------------------------------------------------------
# _get_new_and_missing_images — set diff using the canonical key
# ---------------------------------------------------------------------------


def _embeddings_stub(tmp_path: Path) -> Embeddings:
    """Construct an ``Embeddings`` pointed at a path inside ``tmp_path`` so
    the encoder spec and clip root are valid but no model is ever loaded —
    we only exercise the pure-Python diff method here."""
    return Embeddings(embeddings_path=tmp_path / "stub.npz")


class TestNewAndMissingDiff:
    def test_exact_match_yields_empty_diff(self, tmp_path):
        emb = _embeddings_stub(tmp_path)
        live = [Path("/album/a.jpg"), Path("/album/b.jpg")]
        existing = np.array(["/album/a.jpg", "/album/b.jpg"])

        with patch.object(Embeddings, "get_image_files", return_value=live):
            new, missing = emb._get_new_and_missing_images(
                image_paths_or_dir=live, existing_filenames=existing
            )

        assert new == set()
        assert missing == set()

    def test_added_file_appears_in_new(self, tmp_path):
        emb = _embeddings_stub(tmp_path)
        live = [Path("/album/a.jpg"), Path("/album/b.jpg")]
        existing = np.array(["/album/a.jpg"])

        with patch.object(Embeddings, "get_image_files", return_value=live):
            new, missing = emb._get_new_and_missing_images(
                image_paths_or_dir=live, existing_filenames=existing
            )

        assert new == {Path("/album/b.jpg")}
        assert missing == set()

    def test_removed_file_appears_in_missing(self, tmp_path):
        emb = _embeddings_stub(tmp_path)
        live = [Path("/album/a.jpg")]
        existing = np.array(["/album/a.jpg", "/album/b.jpg"])

        with patch.object(Embeddings, "get_image_files", return_value=live):
            new, missing = emb._get_new_and_missing_images(
                image_paths_or_dir=live, existing_filenames=existing
            )

        assert new == set()
        assert missing == {Path("/album/b.jpg")}

    def test_case_only_rename_is_not_double_encoded(self, tmp_path):
        """Regression test for the case-insensitive-FS bug.

        The same file is recorded in the cache as ``Photo.JPG`` (upper)
        and scanned from the filesystem as ``photo.jpg`` (lower). On a
        case-insensitive FS these are the same file; on a case-sensitive
        FS Python can't tell either way. The diff should treat them as
        the same entry — neither new nor missing.
        """
        emb = _embeddings_stub(tmp_path)
        live = [Path("/album/photo.jpg")]
        existing = np.array(["/album/Photo.JPG"])

        with patch.object(Embeddings, "get_image_files", return_value=live):
            new, missing = emb._get_new_and_missing_images(
                image_paths_or_dir=live, existing_filenames=existing
            )

        assert new == set(), "expected no new file (case-folded match)"
        assert missing == set(), "expected no missing file (case-folded match)"

    def test_case_only_rename_preserves_live_casing_for_new_files(self, tmp_path):
        """When a *new* path differs only in case from a cached path, the
        Path returned in ``missing`` is the cache-stored original-case
        version (preserved for downstream filesystem-mask work in
        ``_filter_missing_images``)."""
        emb = _embeddings_stub(tmp_path)
        # Live scan has lowercase only; cache has upper for one file plus a
        # genuinely new mixed-case entry.
        live = [Path("/album/photo.jpg"), Path("/album/NewShot.PNG")]
        existing = np.array(["/album/Photo.JPG"])

        with patch.object(Embeddings, "get_image_files", return_value=live):
            new, missing = emb._get_new_and_missing_images(
                image_paths_or_dir=live, existing_filenames=existing
            )

        # ``NewShot.PNG`` is genuinely new — and the original casing is
        # preserved so PIL.open() and EXIF read use the actual file name.
        assert new == {Path("/album/NewShot.PNG")}
        # The case-only-rename file is neither new nor missing.
        assert missing == set()
