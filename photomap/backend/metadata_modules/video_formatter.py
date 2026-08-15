"""Render video facts for the metadata drawer.

Emits a panel in the same shape ``exif_formatter`` uses — a bold section
heading over an ``exif-table`` of ``<th>label</th><td>value</td>`` rows — so
the drawer's existing styling and copy-icon delegation apply unchanged.

This panel *precedes* rather than replaces the EXIF panel: phone videos
routinely carry a creation date and GPS coordinates worth showing, so both
are rendered when both are present.
"""

from __future__ import annotations

import html
from logging import getLogger

from .slide_summary import SlideSummary

logger = getLogger(__name__)


def _esc(value: object) -> str:
    return html.escape(str(value))


def format_duration(seconds: float | None) -> str:
    """Human-readable clock time: 7.4 -> '0:07', 3725 -> '1:02:05'."""
    if seconds is None:
        return "Unknown"
    try:
        total = int(round(float(seconds)))
    except (TypeError, ValueError):
        return "Unknown"
    if total < 0:
        return "Unknown"
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def format_fps(fps: float | None) -> str:
    """'30 fps' for whole rates, '29.97 fps' otherwise."""
    if fps is None:
        return "Unknown"
    try:
        value = float(fps)
    except (TypeError, ValueError):
        return "Unknown"
    if value <= 0:
        return "Unknown"
    if abs(value - round(value)) < 0.01:
        return f"{int(round(value))} fps"
    return f"{value:.2f} fps"


def _resolution(info: dict) -> str | None:
    width, height = info.get("width"), info.get("height")
    if not width or not height:
        return None
    return f"{int(width)} × {int(height)}"


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
    if info.get("playable") is False:
        rows.append(
            ("Playback", "Not supported by browsers — use the download link")
        )

    html_doc = (
        "<div class='video-metadata'>"
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
