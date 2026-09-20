"""The JSON sidecar InvokeAI wrote beside a video before it embedded metadata.

Releases before InvokeAI 7 kept a generated video's generation record in a
separate file under ``{outputs}/videos/sidecars/``, mirroring the video's own
subfolder:

    outputs/videos/general/<uuid>.mp4
    outputs/videos/sidecars/general/<uuid>.json

    outputs/videos/<uuid>.mp4          # no subfolder
    outputs/videos/sidecars/<uuid>.json

The file holds the same three strings an InvokeAI 7 MP4 carries as keyed
metadata — ``invokeai_metadata``, ``invokeai_workflow`` and
``invokeai_graph`` — each a *stringified* JSON document, or null when that
generation produced none. In a 662-sidecar sample from a real install, 530
carried a null record (workflow only) and 132 a real one, so "the file exists
but has nothing for us" is the common case, not an error.

InvokeAI 7 still writes a sidecar when the metadata remux fails, so this is
not purely a legacy path.

**Finding the sidecar from the video alone.** PhotoMapAI indexes absolute
file paths and never learns where an InvokeAI ``outputs`` directory begins,
so the videos root has to be guessed: each ancestor of the video is tried as
the root, nearest first, and the video's path relative to it is mirrored
under ``sidecars/``. The walk is bounded because InvokeAI's own subfolder is
one level deep in practice (the ``general`` / ``intermediate`` / ``user``
category) even though its validator permits more.

A false positive would need a directory literally named ``sidecars`` holding
a JSON file with the video's stem, an ``invokeai_metadata`` key, *and* a
record that looks like InvokeAI's — all three are required rather than
assumed, and the last is the same test the drawer routes on.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from .metadata_modules.invokemetadata import looks_like_invoke_metadata

logger = logging.getLogger(__name__)

# The directory InvokeAI puts sidecars in, relative to the videos root.
SIDECAR_DIRNAME = "sidecars"

# How many ancestors of the video to try as the videos root. Measured
# against a real install: all 661 sidecars there resolved at depth 1, the
# category directory, and none at any other depth. Depth 0 covers a videos
# root with no subfolder at all.
#
# Deliberately not deeper. InvokeAI's ``video_subfolder`` is a path and its
# validator would accept more than one segment, but no caller writes one,
# and each extra level is a file the reader opens *outside* the album the
# user configured — at depth 3 that is a path at the filesystem root. Since
# the headroom buys nothing measurable, it is not worth that reach.
MAX_SUBFOLDER_DEPTH = 1

# A sidecar holds all three strings, the graph being the large one, and runs
# to a few hundred KiB. The cap only stops a hostile or corrupt file from
# being read into memory whole, which JSON parsing requires and the MP4 walk
# does not. Matched to ``mp4_metadata.MAX_TAG_BYTES`` so the same record is
# not rejected from one source and accepted from the other.
MAX_SIDECAR_BYTES = 8 * 1024 * 1024

# The key holding the generation record. Required, so that an unrelated
# ``sidecars`` directory cannot be mistaken for InvokeAI's.
METADATA_KEY = "invokeai_metadata"


def sidecar_candidates(video_path: Path) -> Iterator[Path]:
    """Where ``video_path``'s sidecar would be, nearest videos root first.

    Yields at most ``MAX_SUBFOLDER_DEPTH + 1`` paths and stops early at the
    filesystem root. Nothing is touched on disk here — pass a *resolved*
    path, or a ``..`` in it will survive into the candidate and let the
    kernel resolve it back out of the ``sidecars`` directory at open time.
    :func:`read_sidecar_metadata` resolves before calling this.
    """
    filename = video_path.stem + ".json"
    parent = video_path.parent
    for depth in range(MAX_SUBFOLDER_DEPTH + 1):
        try:
            root = video_path.parents[depth]
        except IndexError:
            # Ran out of ancestors before the depth limit.
            return
        # "" at depth 0, the category at depth 1, and so on. pathlib drops
        # the "." that ``relative_to`` returns for the former.
        subpath = parent.relative_to(root)
        yield root / SIDECAR_DIRNAME / subpath / filename


def read_sidecar_metadata(video_path: Path) -> dict[str, Any]:
    """The generation record from ``video_path``'s sidecar, or ``{}``.

    Returns ``{}`` when there is no sidecar, when the one found carries a
    null record (the common case — 530 of 662 in the sample install), or
    when it is unreadable, oversized, not JSON, or not an InvokeAI sidecar
    at all. Nothing here raises: this runs once per video while indexing a
    collection that contains whatever is on the user's disk.

    A candidate that exists but yields nothing usable does not end the
    search — the next ancestor is still tried.
    """
    for candidate in sidecar_candidates(Path(video_path).resolve()):
        try:
            if not candidate.is_file():
                continue
            if candidate.stat().st_size > MAX_SIDECAR_BYTES:
                logger.warning("Ignoring oversized sidecar %s", candidate)
                continue
            text = candidate.read_text(encoding="utf-8")
        except OSError as e:
            logger.debug("Could not read sidecar %s: %s", candidate, e)
            continue
        except UnicodeDecodeError as e:
            # Split from the JSON failure below purely so the log names the
            # right stage — this never reached the parser.
            logger.warning("Sidecar %s is not UTF-8 text: %s", candidate, e)
            continue

        payload = _loads(text, candidate)
        if not isinstance(payload, dict) or METADATA_KEY not in payload:
            # Not an InvokeAI sidecar — some other file that happens to sit
            # where one would.
            continue

        record = payload[METADATA_KEY]
        if isinstance(record, str):
            # The written shape: stringified, as into a PNG chunk or an MP4
            # tag. Every sidecar in the sample install is this or null.
            record = _loads(record, candidate)
        if isinstance(record, dict):
            if not looks_like_invoke_metadata(record):
                # The key alone is a weak gate: it would hand back whatever
                # object some other tool stored under that name. Require the
                # record to look like InvokeAI's, which is the same test the
                # drawer routes on — and which all 132 records in the sample
                # install pass.
                logger.debug(
                    "Sidecar %s holds no recognisable InvokeAI record", candidate
                )
                continue
            return record
        if record is not None:
            logger.warning(
                "Sidecar record in %s is a %s, not an object",
                candidate,
                type(record).__name__,
            )
        # `null` is a real and common shape: a generation that produced a
        # workflow but no record. Keep looking rather than treating the
        # file's existence as the answer.
    return {}


def _loads(text: str, source: Path) -> Any:
    """``json.loads``, returning ``None`` instead of raising.

    ``RecursionError`` is the reason this is a helper rather than one more
    ``except`` clause: deeply nested JSON raises it, it is a ``RuntimeError``
    and so is caught by neither of the obvious guards, and ~120 KB of nested
    brackets is three orders of magnitude under ``MAX_SIDECAR_BYTES``. It
    escaping here does not merely lose the metadata — ``_load_video`` catches
    it, returns ``None``, and the video is dropped from the album entirely.
    """
    try:
        return json.loads(text)
    except (ValueError, RecursionError) as e:
        logger.warning("Sidecar %s does not hold valid JSON: %s", source, e)
        return None
