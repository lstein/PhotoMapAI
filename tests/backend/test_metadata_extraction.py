"""Unit tests for :mod:`photomap.backend.metadata_extraction`.

Focused on PNG text-chunk normalization. Pillow returns different shapes
for the three PNG text-chunk types (tEXt → str, zTXt → str/bytes, iTXt →
tuple/str depending on Pillow version), so the extractor funnels every
value through :func:`_normalize_text_chunk` before ``json.loads``.
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock

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
