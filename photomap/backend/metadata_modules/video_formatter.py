"""Render video facts for the metadata drawer.

Emits a panel in the same shape ``exif_formatter`` uses — a bold section
heading over a table of ``<th>label</th><td>value</td>`` rows, inside an
``exif-metadata`` wrapper, which is the ancestor selector the drawer
stylesheet actually targets.

This panel *precedes* rather than replaces the EXIF panel, so that a video
carrying a creation date or GPS shows both. Note that today the indexer never
produces EXIF for a video — ``_load_video`` writes only the probe dict — so in
the current pipeline this is always the sole panel. The composition is kept
because it is the correct behavior the moment video EXIF extraction is added,
but no test here should be read as evidence that it happens now.

Every helper returns a placeholder rather than raising. That matters more than
it looks: the values come from parsing ffmpeg's stderr, so ``inf`` is
reachable from a long digit run, and an exception here does not degrade one
row — it takes down the whole ``/retrieve_image`` response.
"""

from __future__ import annotations

import html
import math
from logging import getLogger

from .slide_summary import SlideSummary

logger = getLogger(__name__)


UNKNOWN = "Unknown"


def _esc(value: object) -> str:
    return html.escape("" if value is None else str(value))


def format_duration(seconds: float | None) -> str:
    """Human-readable clock time: 7.4 -> '0:07', 3725 -> '1:02:05'.

    Returns ``"Unknown"`` for anything unusable rather than raising. Note the
    conversions must ALL sit inside the guard: ``round(inf)`` raises
    ``OverflowError``, which is neither a ``TypeError`` nor a ``ValueError``,
    and ``inf`` is reachable — the banner's fps/duration patterns match an
    arbitrarily long digit run and ``float("9" * 400)`` is ``inf`` with no
    exception at all.
    """
    if seconds is None:
        return UNKNOWN
    try:
        value = float(seconds)
        if not math.isfinite(value) or value < 0:
            return UNKNOWN
        total = int(round(value))
        hours, remainder = divmod(total, 3600)
        minutes, secs = divmod(remainder, 60)
    except (TypeError, ValueError, OverflowError):
        return UNKNOWN
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def format_fps(fps: float | None) -> str:
    """'30 fps' for whole rates, '29.97 fps' otherwise, else ``"Unknown"``."""
    if fps is None:
        return UNKNOWN
    try:
        value = float(fps)
        if not math.isfinite(value) or value <= 0:
            return UNKNOWN
        if abs(value - round(value)) < 0.01:
            return f"{int(round(value))} fps"
        return f"{value:.2f} fps"
    except (TypeError, ValueError, OverflowError):
        return UNKNOWN


def _resolution(info: dict) -> str | None:
    """``"1920 × 1080"``, or ``None`` when either dimension is unusable.

    Guarded like every other helper here: the falsy check alone let a
    non-integral value such as ``"1920.0"`` through to ``int()``, which raises
    ``ValueError`` and took down the whole drawer render rather than dropping
    one row.
    """
    try:
        width = int(info.get("width") or 0)
        height = int(info.get("height") or 0)
    except (TypeError, ValueError, OverflowError):
        return None
    if width <= 0 or height <= 0:
        return None
    return f"{width} × {height}"


def video_external_link_html(video_url: str) -> str:
    """A link to the raw video file, for the drawer.

    Kept separate from :func:`format_video_metadata` because the URL depends
    on the album key, which is only known once the router stamps it — the
    formatter runs earlier and has no album context.
    """
    if not video_url:
        return ""
    return (
        f"<div class='video-external-link' style='margin-top:6px; font-size:0.95em;'>"
        f"<a href='{_esc(video_url)}' target='_blank' rel='noopener' "
        f"style='color:white;'>Open video externally</a></div>"
    )


def format_video_metadata(slide_data: SlideSummary, info: dict | None) -> SlideSummary:
    """Render ``info`` (a ``VideoInfo`` dump) into ``slide_data.description``.

    Every field is optional — extraction records what it could determine and
    leaves the rest ``None`` — so each row is emitted only when present, and a
    video with nothing but a frame still renders a sensible panel.
    """
    info = info or {}

    rows: list[tuple[str, str]] = []
    if (duration := info.get("duration")) is not None:
        rows.append(("Duration", format_duration(duration)))
    if (fps := info.get("fps")) is not None:
        rows.append(("Frame Rate", format_fps(fps)))
    if (resolution := _resolution(info)) is not None:
        rows.append(("Resolution", resolution))
    if codec := info.get("codec"):
        rows.append(("Codec", str(codec)))
    if container := info.get("container"):
        rows.append(("Container", str(container)))
    playable = info.get("playable")
    if playable is not None and not playable:
        # Truthiness rather than `is False`: an identity check silently skips
        # a numpy bool or a 0, both of which can survive a round trip through
        # the pickled metadata dict.
        rows.append(("Playback", "Not supported by most browsers"))

    # The wrapper carries `exif-metadata` because that is the ancestor
    # selector metadata-drawer.css actually styles (`.exif-metadata table`,
    # `.exif-metadata th/td`). A bare `video-metadata` matched no rule in any
    # stylesheet, so the panel rendered with no borders, padding or width —
    # and since the indexer writes video metadata as *only* the video dict,
    # this panel is normally the sole panel, so nothing else pulled the
    # styling in. The second class is a hook for future video-only styling.
    html_doc = (
        "<div class='exif-metadata video-metadata'>"
        "<div style=\"font-weight: bold; margin-bottom: 4px;\">🎬 Video</div>"
        "<table class='exif-table'>"
    )
    if rows:
        # Labels are hardcoded above and therefore trusted; values originate
        # from ffmpeg's output and must be escaped.
        for label, value in rows:
            html_doc += f"<tr><th>{label}</th><td>{_esc(value)}</td></tr>"
    else:
        html_doc += (
            "<tr><td><i>No video details available.</i></td></tr>"
        )
    html_doc += "</table></div>"

    slide_data.description = html_doc
    return slide_data
