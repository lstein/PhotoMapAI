"""Unit tests for :mod:`photomap.backend.metadata_extraction`.

Covers PNG text-chunk normalization and the MP4 counterpart. Pillow returns different shapes
for the three PNG text-chunk types (tEXt → str, zTXt → str/bytes, iTXt →
tuple/str depending on Pillow version), so the extractor funnels every
value through :func:`_normalize_text_chunk` before ``json.loads``.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

from fixtures import media_fixture_path

from photomap.backend import metadata_extraction
from photomap.backend.metadata_extraction import (
    MetadataExtractor,
    _normalize_text_chunk,
)

# ---------------------------------------------------------------------------
# _normalize_text_chunk — coercing chunk types to str
# ---------------------------------------------------------------------------


class TestNormalizeTextChunk:
    def test_plain_str_passthrough(self):
        assert _normalize_text_chunk('{"a": 1}') == '{"a": 1}'

    def test_bytes_decoded_utf8(self):
        # zTXt chunks historically returned bytes from Pillow.
        assert _normalize_text_chunk(b'{"a": 1}') == '{"a": 1}'

    def test_bytearray_decoded_utf8(self):
        assert _normalize_text_chunk(bytearray(b'{"a": 1}')) == '{"a": 1}'

    def test_tuple_first_element(self):
        # iTXt chunks in some Pillow versions return
        # (text, lang, translated_keyword) tuples — take the text.
        assert _normalize_text_chunk(('{"a": 1}', "en", "")) == '{"a": 1}'

    def test_empty_tuple(self):
        # Defensive: empty tuple stringifies to ''.
        assert _normalize_text_chunk(()) == ""

    def test_invalid_utf8_replaced(self):
        # ``errors="replace"`` — we'd rather see a question-mark than crash.
        result = _normalize_text_chunk(b'\xff\xfe{"a": 1}')
        assert '{"a": 1}' in result


# ---------------------------------------------------------------------------
# MetadataExtractor.extract_image_metadata — end-to-end with normalized chunks
# ---------------------------------------------------------------------------


def _fake_image(info: dict) -> MagicMock:
    """Pillow ``Image`` stand-in with a controllable ``info`` dict."""
    img = MagicMock()
    img.info = info
    return img


class TestExtractImageMetadata:
    def test_invokeai_metadata_str(self):
        img = _fake_image({"invokeai_metadata": json.dumps({"seed": 42})})
        assert MetadataExtractor.extract_image_metadata(img) == {"seed": 42}

    def test_invokeai_metadata_bytes(self):
        # Older Pillow / zTXt-encoded chunks: bytes through to json.loads.
        img = _fake_image(
            {"invokeai_metadata": json.dumps({"seed": 42}).encode("utf-8")}
        )
        assert MetadataExtractor.extract_image_metadata(img) == {"seed": 42}

    def test_invokeai_metadata_itxt_tuple(self):
        # iTXt chunks in some Pillow versions land as a tuple — previously
        # ``json.loads(tuple)`` raised TypeError and the metadata was lost.
        img = _fake_image(
            {"invokeai_metadata": (json.dumps({"seed": 42}), "en", "")}
        )
        assert MetadataExtractor.extract_image_metadata(img) == {"seed": 42}

    def test_falls_through_on_bad_json(self):
        # Bad JSON in invokeai_metadata, no other metadata → empty dict
        # (the warning is logged, not re-raised).
        img = _fake_image({"invokeai_metadata": "{not valid json"})
        assert MetadataExtractor.extract_image_metadata(img) == {}

    def test_no_metadata_returns_empty(self):
        assert MetadataExtractor.extract_image_metadata(_fake_image({})) == {}


# ---------------------------------------------------------------------------
# extract_video_metadata — the MP4 counterpart
# ---------------------------------------------------------------------------


class TestExtractVideoMetadata:
    """A video's generation record, lifted out of the MP4's keyed metadata.

    The contract that matters here is the failure contract: indexing calls
    this once per video across a whole collection, and a collection contains
    phone footage, screen recordings and half-copied files as well as
    InvokeAI output. Not one of those may raise.
    """

    def test_returns_the_embedded_record(self):
        record = MetadataExtractor.extract_video_metadata(
            media_fixture_path("invoke_video.mp4")
        )

        assert record["generation_mode"] == "wan_i2v"
        assert record["num_frames"] == 81
        assert record["model"]["name"] == "Wan 2.2 I2V A14B"

    def test_reads_only_the_record_not_the_workflow_or_graph(self):
        """Both are present in the fixture; neither belongs in the drawer.

        PhotoMapAI renders neither, and skipping them keeps the read to the
        few KiB of the record instead of the few hundred KiB of a graph.
        """
        record = MetadataExtractor.extract_video_metadata(
            media_fixture_path("invoke_video.mp4")
        )

        assert "nodes" not in record
        assert "edges" not in record

    def test_a_video_with_no_tags_yields_an_empty_dict(self):
        assert MetadataExtractor.extract_video_metadata(
            media_fixture_path("clip.mp4")
        ) == {}

    def test_a_non_mp4_container_yields_an_empty_dict(self):
        assert MetadataExtractor.extract_video_metadata(
            media_fixture_path("clip.webm")
        ) == {}

    def test_a_truncated_file_yields_an_empty_dict(self):
        assert MetadataExtractor.extract_video_metadata(
            media_fixture_path("broken.mp4")
        ) == {}

    def test_a_missing_file_yields_an_empty_dict(self, tmp_path):
        """The OSError the reader raises is swallowed here, not upstream."""
        assert MetadataExtractor.extract_video_metadata(tmp_path / "gone.mp4") == {}

    def test_a_tag_that_is_not_json_yields_an_empty_dict(self, monkeypatch):
        monkeypatch.setattr(
            metadata_extraction,
            "read_mp4_tags",
            lambda path, keys=None: {"invokeai_metadata": "{not valid json"},
        )

        assert MetadataExtractor.extract_video_metadata(Path("any.mp4")) == {}

    def test_a_tag_holding_json_that_is_not_an_object_yields_an_empty_dict(
        self, monkeypatch
    ):
        """Everything downstream indexes the record by key."""
        monkeypatch.setattr(
            metadata_extraction,
            "read_mp4_tags",
            lambda path, keys=None: {"invokeai_metadata": "[1, 2, 3]"},
        )

        assert MetadataExtractor.extract_video_metadata(Path("any.mp4")) == {}

    def test_an_empty_tag_yields_an_empty_dict(self, monkeypatch):
        monkeypatch.setattr(
            metadata_extraction,
            "read_mp4_tags",
            lambda path, keys=None: {"invokeai_metadata": ""},
        )

        assert MetadataExtractor.extract_video_metadata(Path("any.mp4")) == {}
