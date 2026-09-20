"""The MP4 keyed-metadata reader.

Two kinds of test here, and both are needed.

The first reads ``test_media/invoke_video.mp4``, a 1s clip tagged by the
bundled ffmpeg exactly the way InvokeAI 7 tags a generated video — a
stream-copy remux with ``-movflags use_metadata_tags`` carrying the three
``invokeai_*`` JSON strings in an ffmetadata file. That is the only test that
proves the walk matches a *real writer*; a reader validated solely against
boxes this file builds would only prove it agrees with itself. Its prompt
deliberately contains ``=``, ``;``, ``#`` and a line break, every character
the ffmetadata grammar escapes, so the round trip covers an escaped payload.

The second builds boxes byte by byte, because the interesting inputs are the
ones no writer produces: a truncated ``moov``, a ``keys`` table claiming four
billion entries, a non-UTF-8 key. Those are what stands between "indexing a
collection" and "a hostile file hangs or exhausts the indexer".

Regenerating the fixture, if the tagging convention ever changes: encode any
short clip, then remux it with ``-map 0:v:0 -map_metadata 1 -c copy -movflags
+faststart+use_metadata_tags`` against a ``;FFMETADATA1`` file holding the
three keys.
"""

from __future__ import annotations

import json
import struct

import pytest
from fixtures import media_fixture_path

from photomap.backend import mp4_metadata
from photomap.backend.mp4_metadata import (
    INVOKEAI_GRAPH_KEY,
    INVOKEAI_METADATA_KEY,
    INVOKEAI_WORKFLOW_KEY,
    MAX_TAG_BYTES,
    read_mp4_tags,
)

# --------------------------------------------------------------------------
# Synthetic box construction
# --------------------------------------------------------------------------


def box(box_type: bytes, payload: bytes) -> bytes:
    """A 32-bit-size box: ``[size][type][payload]``."""
    return struct.pack(">I4s", len(payload) + 8, box_type) + payload


def large_box(box_type: bytes, payload: bytes) -> bytes:
    """A 64-bit-size box — size word of 1, real size after the type."""
    return struct.pack(">I4sQ", 1, box_type, len(payload) + 16) + payload


def keys_box(names: list[bytes], namespace: bytes = b"mdta") -> bytes:
    """An ``mdta`` key table. Index order is the order given."""
    entries = b"".join(
        struct.pack(">I4s", len(name) + 8, namespace) + name for name in names
    )
    return box(b"keys", struct.pack(">II", 0, len(names)) + entries)


def data_atom(value: bytes, type_indicator: int = 1) -> bytes:
    """A ``data`` atom. Indicator 1 is UTF-8; anything else is not text."""
    return box(b"data", struct.pack(">II", type_indicator, 0) + value)


def ilst_box(items: list[tuple[int, bytes]]) -> bytes:
    """An ``ilst``. Each item's *box type* is its 1-based index into ``keys``."""
    return box(
        b"ilst",
        b"".join(box(struct.pack(">I", index), payload) for index, payload in items),
    )


def quicktime_meta(children: bytes) -> bytes:
    """``meta`` as QuickTime writes it — a plain box, no version/flags word."""
    return box(b"meta", children)


def isobmff_meta(children: bytes) -> bytes:
    """``meta`` as ISO BMFF defines it — a FullBox, four leading bytes."""
    return box(b"meta", b"\x00\x00\x00\x00" + children)


def mp4_with_meta(meta: bytes, leading: bytes = b"") -> bytes:
    """A minimal file: ``ftyp``, an ``mdat`` to skip, then ``moov/udta/meta``."""
    return (
        box(b"ftyp", b"isom\x00\x00\x02\x00isomiso2")
        + box(b"mdat", b"\x00" * 512)
        + leading
        + box(b"moov", box(b"udta", meta))
    )


def tagged_file(tags: dict[str, str], meta_builder=quicktime_meta) -> bytes:
    names = [key.encode("utf-8") for key in tags]
    items = [
        (index, data_atom(value.encode("utf-8")))
        for index, value in enumerate(tags.values(), start=1)
    ]
    return mp4_with_meta(meta_builder(keys_box(names) + ilst_box(items)))


@pytest.fixture
def write_mp4(tmp_path):
    """Write raw bytes to a ``.mp4`` in ``tmp_path`` and return the path."""
    counter = {"n": 0}

    def _write(data: bytes):
        counter["n"] += 1
        path = tmp_path / f"synthetic{counter['n']}.mp4"
        path.write_bytes(data)
        return path

    return _write


# --------------------------------------------------------------------------
# The real writer
# --------------------------------------------------------------------------


def test_reads_the_three_keys_an_invokeai_video_carries():
    tags = read_mp4_tags(media_fixture_path("invoke_video.mp4"))

    assert INVOKEAI_METADATA_KEY in tags
    assert INVOKEAI_WORKFLOW_KEY in tags
    assert INVOKEAI_GRAPH_KEY in tags
    record = json.loads(tags[INVOKEAI_METADATA_KEY])
    assert record["generation_mode"] == "wan_i2v"
    assert record["seed"] == 1234567


def test_escaped_characters_survive_the_round_trip():
    """``=``, ``;``, ``#`` and a line break are all special to ffmetadata."""
    tags = read_mp4_tags(media_fixture_path("invoke_video.mp4"))
    prompt = json.loads(tags[INVOKEAI_METADATA_KEY])["positive_prompt"]

    assert prompt == (
        "a paper boat crossing a puddle\nstyle=watercolour; no #hashtags"
    )


def test_requesting_one_key_returns_only_that_key():
    tags = read_mp4_tags(
        media_fixture_path("invoke_video.mp4"), keys=(INVOKEAI_METADATA_KEY,)
    )

    assert list(tags) == [INVOKEAI_METADATA_KEY]


def test_non_invokeai_tags_are_returned_too():
    """The reader is about the container, not about InvokeAI.

    ffmpeg stamps its own ``encoder`` tag on the remux; an unfiltered read
    returns it alongside the three we asked for, which is what makes this
    module reusable for any keyed metadata.
    """
    tags = read_mp4_tags(media_fixture_path("invoke_video.mp4"))

    assert "encoder" in tags


@pytest.mark.parametrize("name", ["clip.mp4", "clip.webm", "broken.mp4"])
def test_files_without_keyed_metadata_read_as_no_tags(name):
    """An untagged MP4, a different container, and a truncated file.

    None of the three may raise: every video in a collection goes through
    this call during indexing.
    """
    assert read_mp4_tags(media_fixture_path(name)) == {}


# --------------------------------------------------------------------------
# Box-walk structure
# --------------------------------------------------------------------------


def test_reads_an_isobmff_fullbox_meta(write_mp4):
    """``meta`` carries a version/flags word in ISO BMFF but not in QuickTime.

    The disambiguation is by lookahead, not by brand, so both layouts read.
    """
    path = write_mp4(tagged_file({"a": "1"}, meta_builder=isobmff_meta))

    assert read_mp4_tags(path) == {"a": "1"}


def test_reads_past_a_64_bit_sized_box(write_mp4):
    """A large ``mdat`` uses the 64-bit size form; the walk must step over it."""
    data = (
        box(b"ftyp", b"isom")
        + large_box(b"mdat", b"\x00" * 64)
        + box(b"moov", box(b"udta", quicktime_meta(
            keys_box([b"a"]) + ilst_box([(1, data_atom(b"1"))])
        )))
    )

    assert read_mp4_tags(write_mp4(data)) == {"a": "1"}


def test_a_size_zero_box_before_moov_swallows_the_rest_of_the_file(write_mp4):
    """Size 0 means "to end of file", so nothing after it is reachable.

    Not a defect to fix — it is what the format says — but worth pinning,
    because it is the one shape where a *valid* box legitimately hides
    ``moov`` from the walk.
    """
    data = (
        struct.pack(">I4s", 0, b"free")
        + box(b"moov", box(b"udta", quicktime_meta(
            keys_box([b"a"]) + ilst_box([(1, data_atom(b"1"))])
        )))
    )

    assert read_mp4_tags(write_mp4(data)) == {}


def test_a_box_overrunning_its_parent_ends_the_walk(write_mp4):
    """A truncated file: ``moov`` claims more bytes than the file holds."""
    good = tagged_file({"a": "1"})
    data = good[:-40]

    assert read_mp4_tags(write_mp4(data)) == {}


def test_a_box_smaller_than_its_own_header_ends_the_walk(write_mp4):
    """Size 4 cannot even hold the 8-byte header, so the walk stops there."""
    data = (
        box(b"ftyp", b"isom")
        + struct.pack(">I4s", 4, b"junk")
        + box(b"moov", box(b"udta", quicktime_meta(
            keys_box([b"a"]) + ilst_box([(1, data_atom(b"1"))])
        )))
    )

    assert read_mp4_tags(write_mp4(data)) == {}


def test_thousands_of_tiny_top_level_boxes_are_given_up_on(write_mp4):
    """A file padded past the top-level box bound is abandoned, not walked.

    ``moov`` precedes every fragment in a real fragmented file, so a file
    that buries it behind thousands of boxes is pathological by construction
    — and walking it unbounded is a per-file stall during indexing.
    """
    padding = box(b"free", b"") * 2000
    data = padding + box(b"moov", box(b"udta", quicktime_meta(
        keys_box([b"a"]) + ilst_box([(1, data_atom(b"1"))])
    )))

    assert read_mp4_tags(write_mp4(data)) == {}


def test_missing_udta_meta_keys_or_ilst_each_read_as_no_tags(write_mp4):
    assert read_mp4_tags(write_mp4(box(b"moov", b""))) == {}
    assert read_mp4_tags(write_mp4(box(b"moov", box(b"udta", b"")))) == {}
    # keys without ilst, and ilst without keys.
    assert read_mp4_tags(
        write_mp4(mp4_with_meta(quicktime_meta(keys_box([b"a"]))))
    ) == {}
    assert read_mp4_tags(
        write_mp4(mp4_with_meta(quicktime_meta(ilst_box([(1, data_atom(b"1"))]))))
    ) == {}


# --------------------------------------------------------------------------
# The keys table
# --------------------------------------------------------------------------


def test_an_absurd_key_count_is_refused_rather_than_read(write_mp4):
    """The count is the file's own claim, and it sizes the reader's loop."""
    hostile = box(b"keys", struct.pack(">II", 0, 0xFFFFFFFF))
    data = mp4_with_meta(
        quicktime_meta(hostile + ilst_box([(1, data_atom(b"1"))]))
    )

    assert read_mp4_tags(write_mp4(data)) == {}


def test_a_count_larger_than_the_table_stops_at_the_table_end(write_mp4):
    """A plausible count that overruns the box truncates instead of reading on."""
    entries = struct.pack(">I4s", 9, b"mdta") + b"a"
    lying = box(b"keys", struct.pack(">II", 0, 5) + entries)
    data = mp4_with_meta(
        quicktime_meta(lying + ilst_box([(1, data_atom(b"1"))]))
    )

    assert read_mp4_tags(write_mp4(data)) == {"a": "1"}


def test_a_non_utf8_key_name_is_dropped_but_its_neighbours_survive(write_mp4):
    entries = (
        struct.pack(">I4s", 10, b"mdta") + b"\xff\xfe"
        + struct.pack(">I4s", 9, b"mdta") + b"b"
    )
    table = box(b"keys", struct.pack(">II", 0, 2) + entries)
    data = mp4_with_meta(
        quicktime_meta(
            table + ilst_box([(1, data_atom(b"1")), (2, data_atom(b"2"))])
        )
    )

    assert read_mp4_tags(write_mp4(data)) == {"b": "2"}


def test_keys_outside_the_mdta_namespace_are_ignored(write_mp4):
    """Only ``mdta`` names this module; other namespaces index differently."""
    table = keys_box([b"a"], namespace=b"udta")
    data = mp4_with_meta(
        quicktime_meta(table + ilst_box([(1, data_atom(b"1"))]))
    )

    assert read_mp4_tags(write_mp4(data)) == {}


def test_an_ilst_item_naming_no_key_is_skipped(write_mp4):
    """Item index 7 against a one-entry table: unreferenceable, so dropped."""
    data = mp4_with_meta(
        quicktime_meta(
            keys_box([b"a"])
            + ilst_box([(7, data_atom(b"1")), (1, data_atom(b"2"))])
        )
    )

    assert read_mp4_tags(write_mp4(data)) == {"a": "2"}


# --------------------------------------------------------------------------
# The data atoms
# --------------------------------------------------------------------------


def test_a_non_utf8_type_indicator_is_not_text_and_is_skipped(write_mp4):
    """Indicator 21 is a big-endian integer, 13 a JPEG. Neither is a string."""
    data = mp4_with_meta(
        quicktime_meta(
            keys_box([b"a", b"b"])
            + ilst_box(
                [
                    (1, data_atom(b"\x00\x00\x00\x2a", type_indicator=21)),
                    (2, data_atom(b"text")),
                ]
            )
        )
    )

    assert read_mp4_tags(write_mp4(data)) == {"b": "text"}


def test_the_first_utf8_atom_wins_when_an_item_holds_several(write_mp4):
    item = data_atom(b"\x2a", type_indicator=21) + data_atom(b"first") + data_atom(b"second")
    data = mp4_with_meta(
        quicktime_meta(keys_box([b"a"]) + box(b"ilst", box(b"\x00\x00\x00\x01", item)))
    )

    assert read_mp4_tags(write_mp4(data)) == {"a": "first"}


def test_undecodable_utf8_yields_no_value_for_that_key(write_mp4):
    data = mp4_with_meta(
        quicktime_meta(
            keys_box([b"a", b"b"])
            + ilst_box([(1, data_atom(b"\xff\xfe\xfd")), (2, data_atom(b"ok"))])
        )
    )

    assert read_mp4_tags(write_mp4(data)) == {"b": "ok"}


def test_a_value_over_the_size_cap_is_refused(write_mp4, monkeypatch):
    """A value larger than the cap is dropped, and its neighbours are not.

    The cap is lowered rather than an 8 MiB file written: what is under test
    is the comparison, and a well-formed oversized atom is the only shape
    that reaches it — a merely *lying* size is caught earlier, by the
    overrun check in the box walk.
    """
    monkeypatch.setattr(mp4_metadata, "MAX_TAG_BYTES", 4)
    data = mp4_with_meta(
        quicktime_meta(
            keys_box([b"big", b"small"])
            + ilst_box([(1, data_atom(b"far too long")), (2, data_atom(b"ok"))])
        )
    )

    assert read_mp4_tags(write_mp4(data)) == {"small": "ok"}


def test_the_cap_is_well_above_a_real_record():
    """A graph JSON runs to a few hundred KiB; the cap must not clip one."""
    assert MAX_TAG_BYTES >= 1024 * 1024


def test_an_empty_utf8_value_is_kept_as_an_empty_string(write_mp4):
    """Distinct from "absent" — a caller may care that the tag was written."""
    data = mp4_with_meta(quicktime_meta(keys_box([b"a"]) + ilst_box([(1, data_atom(b""))])))

    assert read_mp4_tags(write_mp4(data)) == {"a": ""}


def test_an_unreadable_path_raises_rather_than_reporting_no_tags(tmp_path):
    """I/O errors are the one thing that propagates; the caller decides."""
    with pytest.raises(OSError):
        read_mp4_tags(tmp_path / "does-not-exist.mp4")
