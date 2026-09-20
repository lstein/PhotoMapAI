"""Read the keyed metadata an MP4 carries in its ``moov`` box.

InvokeAI 7 stores the same three strings a generated PNG carries as ``tEXt``
chunks — ``invokeai_metadata``, ``invokeai_workflow`` and ``invokeai_graph`` —
inside a generated ``.mp4`` as QuickTime *keyed metadata*: a
``moov/udta/meta`` box holding an ``mdta`` ``keys`` table paired with an
``ilst`` of UTF-8 ``data`` atoms. That is the layout ffmpeg writes for
``-movflags use_metadata_tags`` and the one ffprobe, exiftool and mediainfo
display, so this walk reads any file tagged by those tools, not only
InvokeAI's.

Reading is a pure-Python box walk rather than an ffprobe call, for two
reasons. The bundled ``imageio-ffmpeg`` ships ffmpeg *without* ffprobe, so
there is no probe binary to call in the first place. And a box walk costs a
handful of seeks whatever the file's size: ``mdat``, which is all of the
video data, is stepped over by its declared size and never read. This runs
once per video while indexing a collection that is often on a network mount,
so "a few seeks" versus "stream the file" is the whole design.

Nothing here raises on a bad file. A truncated MP4, a ``.webm`` that reached
this function by mistake, a file with no keyed metadata, or a hostile one
declaring absurd box sizes all read as "no tags"; only I/O errors propagate,
and the sole caller treats those as "no tags" too. The bounds below exist so
that a hostile file cannot make the reader allocate or loop on its own
say-so — every one of them is far above what a real file needs.
"""

from __future__ import annotations

import struct
from collections.abc import Collection, Iterator
from pathlib import Path
from typing import BinaryIO

# The three keys InvokeAI writes. Kept here rather than imported from the
# metadata modules because they name a *container* convention: any tool that
# writes these tags is readable by this module.
INVOKEAI_METADATA_KEY = "invokeai_metadata"
INVOKEAI_WORKFLOW_KEY = "invokeai_workflow"
INVOKEAI_GRAPH_KEY = "invokeai_graph"
INVOKEAI_KEYS = (INVOKEAI_METADATA_KEY, INVOKEAI_WORKFLOW_KEY, INVOKEAI_GRAPH_KEY)

# A single tag is JSON the generating app produced; the graph is the largest
# and runs to a few hundred KiB. The cap only stops a hostile file from
# making the reader allocate its declared size.
MAX_TAG_BYTES = 8 * 1024 * 1024
# ``keys`` is a table of short names — a hostile count or name length is
# refused rather than read.
_MAX_KEYS = 4096
_MAX_KEY_NAME_BYTES = 1024
# A real file has at most a dozen top-level boxes, and ``moov`` precedes
# every fragment in a fragmented file, so a file padded with tiny top-level
# boxes is given up on rather than walked.
_MAX_TOP_LEVEL_BOXES = 1024
# The same bound inside ``moov``. Its children *are* bounded by its declared
# size, but only in bytes: a 1 GB ``moov`` packed with 8-byte ``free`` boxes
# is ~130 M iterations of seek-and-read, which is a minute of index time per
# such file. A real ``moov`` has a handful of children, a real ``ilst`` one
# item per tag, and a real ``meta`` three or four.
_MAX_CHILD_BOXES = 1024

# The ``data`` atom's type indicator for UTF-8 text. Other indicators mark
# integers, JPEG payloads and so on; we want text and skip the rest.
_UTF8_TYPE_INDICATOR = 1


def _iter_boxes(
    fh: BinaryIO, start: int, end: int, max_boxes: int | None = None
) -> Iterator[tuple[bytes, int, int]]:
    """Yield ``(type, payload_start, payload_end)`` for each box in ``[start, end)``.

    Stops silently at the first structurally impossible box — one whose size
    is smaller than its own header, or which overruns ``end`` — which is how
    a truncated or non-MP4 file reads as "no tags" instead of raising.
    ``max_boxes`` ends the walk after that many boxes.
    """
    position = start
    seen = 0
    while position + 8 <= end and (max_boxes is None or seen < max_boxes):
        seen += 1
        fh.seek(position)
        header = fh.read(8)
        if len(header) < 8:
            return
        size = int.from_bytes(header[:4], "big")
        box_type = header[4:8]
        header_size = 8
        if size == 1:
            # 64-bit size: the real size follows the header.
            extended = fh.read(8)
            if len(extended) < 8:
                return
            size = int.from_bytes(extended, "big")
            header_size = 16
        elif size == 0:
            # "Extends to end of file" — legal only for the last top-level box.
            size = end - position
        if size < header_size or position + size > end:
            return
        yield box_type, position + header_size, position + size
        position += size


def _find_box(
    fh: BinaryIO, start: int, end: int, box_type: bytes, max_boxes: int | None = None
) -> tuple[int, int] | None:
    """The payload bounds of the first ``box_type`` box in ``[start, end)``."""
    for found_type, payload_start, payload_end in _iter_boxes(fh, start, end, max_boxes):
        if found_type == box_type:
            return payload_start, payload_end
    return None


def _meta_payload_start(fh: BinaryIO, start: int, end: int) -> int:
    """Where ``meta``'s children begin.

    ``meta`` is a FullBox — four bytes of version and flags before its first
    child — in ISO BMFF, but a plain box in QuickTime files. Disambiguate the
    way ffmpeg does: if the bytes immediately after the header already spell
    a known child box type, there is no version/flags word to skip.
    """
    if start + 8 > end:
        return start
    fh.seek(start + 4)
    if fh.read(4) in (b"hdlr", b"keys", b"ilst", b"mhdr"):
        return start
    return start + 4


def _read_keys(fh: BinaryIO, start: int, end: int) -> dict[int, str]:
    """The ``keys`` table as ``{1-based index: name}``, ``mdta`` namespace only.

    The index is what an ``ilst`` item is named by: the item's *box type* is
    the big-endian index into this table rather than a four-character code.
    """
    if start + 8 > end:
        return {}
    fh.seek(start)
    _version_flags, count = struct.unpack(">II", fh.read(8))
    if count > _MAX_KEYS:
        return {}
    keys: dict[int, str] = {}
    position = start + 8
    for index in range(1, count + 1):
        if position + 8 > end:
            break
        fh.seek(position)
        size, namespace = struct.unpack(">I4s", fh.read(8))
        if size < 8 or position + size > end:
            break
        if namespace == b"mdta" and size - 8 <= _MAX_KEY_NAME_BYTES:
            try:
                keys[index] = fh.read(size - 8).decode("utf-8")
            except UnicodeDecodeError:
                # A key we cannot name is a key no caller can ask for.
                pass
        position += size
    return keys


def _read_utf8_data(fh: BinaryIO, start: int, end: int) -> str | None:
    """The first UTF-8 ``data`` atom of an ``ilst`` item, or ``None``."""
    for box_type, payload_start, payload_end in _iter_boxes(fh, start, end):
        if box_type != b"data" or payload_end - payload_start < 8:
            continue
        fh.seek(payload_start)
        type_indicator, _locale = struct.unpack(">II", fh.read(8))
        if type_indicator != _UTF8_TYPE_INDICATOR:
            continue
        length = payload_end - payload_start - 8
        if length > MAX_TAG_BYTES:
            return None
        try:
            return fh.read(length).decode("utf-8")
        except UnicodeDecodeError:
            return None
    return None


def read_mp4_tags(path: Path, keys: Collection[str] | None = None) -> dict[str, str]:
    """Return an MP4's ``mdta`` keyed metadata as ``{key: value}``.

    Only UTF-8 values are returned; a tag holding an integer or an image is
    skipped. ``keys`` restricts the result — and the bytes read — to the
    named tags. A file that is not an MP4, carries no keyed metadata, or is
    truncated yields ``{}``. Only I/O errors propagate.
    """
    wanted = set(keys) if keys is not None else None
    with open(path, "rb") as fh:
        fh.seek(0, 2)
        file_size = fh.tell()
        # Every ``moov``, not just the first: a file may carry a second one
        # (a partial rewrite, a concatenation), and giving up because the
        # first has no ``udta`` would miss tags that are plainly there.
        for box_type, start, end in _iter_boxes(
            fh, 0, file_size, _MAX_TOP_LEVEL_BOXES
        ):
            if box_type != b"moov":
                continue
            result = _read_moov_tags(fh, start, end, wanted)
            if result:
                return result
    return {}


def _read_moov_tags(
    fh: BinaryIO, start: int, end: int, wanted: set[str] | None
) -> dict[str, str]:
    """The keyed metadata under one ``moov`` box, or ``{}``."""
    result: dict[str, str] = {}
    udta = _find_box(fh, start, end, b"udta", max_boxes=_MAX_CHILD_BOXES)
    if udta is None:
        return result
    meta = _find_box(fh, *udta, b"meta", max_boxes=_MAX_CHILD_BOXES)
    if meta is None:
        return result
    meta_start = _meta_payload_start(fh, *meta)
    keys_box = _find_box(fh, meta_start, meta[1], b"keys", max_boxes=_MAX_CHILD_BOXES)
    ilst = _find_box(fh, meta_start, meta[1], b"ilst", max_boxes=_MAX_CHILD_BOXES)
    if keys_box is None or ilst is None:
        return result
    names = _read_keys(fh, *keys_box)
    for item_type, item_start, item_end in _iter_boxes(fh, *ilst, _MAX_CHILD_BOXES):
        name = names.get(int.from_bytes(item_type, "big"))
        if name is None or (wanted is not None and name not in wanted):
            continue
        value = _read_utf8_data(fh, item_start, item_end)
        if value is not None:
            result[name] = value
    return result
