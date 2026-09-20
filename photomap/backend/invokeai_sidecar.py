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
a JSON file with the video's stem *and* an ``invokeai_metadata`` key, so the
key is required rather than assumed.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# The directory InvokeAI puts sidecars in, relative to the videos root.
SIDECAR_DIRNAME = "sidecars"

# How many ancestors of the video to try as the videos root. Measured
# against a real install: all 661 sidecars there were found at depth 1, the
# category directory. Depth 0 covers a videos root with no subfolder at all,
# and the rest is headroom, because ``video_subfolder`` is a path and
# InvokeAI's validator accepts more than one segment in it. Each unused
# level costs one ``is_file`` on a video that has no sidecar — the whole
# scan measured 1 ms per video including the MP4 walk.
MAX_SUBFOLDER_DEPTH = 3

# A sidecar holds a graph, which runs to a few hundred KiB. The cap only
# stops a hostile or corrupt file from being read into memory whole — which
# JSON parsing requires, unlike the MP4 walk.
MAX_SIDECAR_BYTES = 32 * 1024 * 1024

# The key holding the generation record. Required, so that an unrelated
# ``sidecars`` directory cannot be mistaken for InvokeAI's.
METADATA_KEY = "invokeai_metadata"


def sidecar_candidates(video_path: Path) -> Iterator[Path]:
    """Where ``video_path``'s sidecar would be, nearest videos root first.

    Yields at most ``MAX_SUBFOLDER_DEPTH + 1`` paths and stops early at the
    filesystem root. Nothing is touched on disk here.
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
    for candidate in sidecar_candidates(video_path):
        try:
            if not candidate.is_file():
                continue
            if candidate.stat().st_size > MAX_SIDECAR_BYTES:
                logger.warning("Ignoring oversized sidecar %s", candidate)
                continue
            payload = json.loads(candidate.read_text(encoding="utf-8"))
        except OSError as e:
            logger.debug("Could not read sidecar %s: %s", candidate, e)
            continue
        except ValueError as e:
            logger.warning("Sidecar %s is not valid JSON: %s", candidate, e)
            continue

        if not isinstance(payload, dict) or METADATA_KEY not in payload:
            # Not an InvokeAI sidecar — some other file that happens to sit
            # where one would.
            continue

        record = payload[METADATA_KEY]
        if isinstance(record, str):
            # The written shape: stringified, as into a PNG chunk or an MP4
            # tag. Every sidecar in the sample install is this or null.
            try:
                record = json.loads(record)
            except ValueError as e:
                logger.warning("Sidecar record in %s is not valid JSON: %s", candidate, e)
                continue
        if isinstance(record, dict):
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
