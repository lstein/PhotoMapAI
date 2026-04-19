"""
backend.metadata_modules.invoke_formatter

Format InvokeAI generation metadata as HTML for the metadata drawer.

This module is a thin HTML renderer over :class:`InvokeMetadataView`, which
provides a version-agnostic view over the Pydantic discriminated union of
v2 / v3 / v5 InvokeAI metadata. The formatter itself does not know anything
about the underlying metadata version layout.
"""

import logging
from collections.abc import Iterable
from datetime import datetime
from pathlib import Path

from pydantic import ValidationError

from .invoke.invoke_metadata_view import (
    ControlLayerTuple,
    InvokeMetadataView,
    LoraTuple,
    ReferenceImageTuple,
)
from .invokemetadata import GenerationMetadataAdapter
from .slide_summary import SlideSummary

logger = logging.getLogger(__name__)


_COPY_SVG = (
    '<span class="copy-icon" title="Copy">'
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" '
    'style="vertical-align:middle;">'
    '<path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 '
    "1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z\"/>"
    "</svg></span>"
)

# Asterisk icon for the recall button — matches InvokeAI's own recall iconography.
_RECALL_SVG = (
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" '
    'aria-hidden="true">'
    '<path d="M12 2a1 1 0 0 1 1 1v6.382l5.536-2.77a1 1 0 0 1 .894 1.789L13.894 '
    '11.17l5.536 2.77a1 1 0 1 1-.894 1.789L13 12.96v6.042a1 1 0 1 1-2 0v-6.042'
    'l-5.536 2.77a1 1 0 0 1-.894-1.789l5.536-2.77-5.536-2.768a1 1 0 0 1 .894'
    '-1.789L11 9.382V3a1 1 0 0 1 1-1z"/>'
    "</svg>"
)

# Two circling arrows — a "refresh / remix" icon matching the reference
# screenshot.
_REMIX_SVG = (
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" '
    'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" '
    'stroke-linejoin="round" aria-hidden="true">'
    '<polyline points="20 4 20 9 15 9"/>'
    '<path d="M20 9A8 8 0 0 0 5.6 6.6"/>'
    '<polyline points="4 20 4 15 9 15"/>'
    '<path d="M4 15a8 8 0 0 0 14.4 2.4"/>'
    "</svg>"
)

# Photo-frame icon — a rectangle with a small sun and a mountain inside,
# drawn in the same stroked style as the remix icon so the three buttons
# share a consistent visual language.
_USE_REF_SVG = (
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" '
    'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" '
    'stroke-linejoin="round" aria-hidden="true">'
    '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>'
    '<circle cx="8.5" cy="8.5" r="1.5"/>'
    '<polyline points="21 15 16 10 5 21"/>'
    "</svg>"
)


_USE_REF_BUTTON_HTML = (
    '<button type="button" class="invoke-recall-btn" data-recall-mode="use_ref" '
    'title="Upload this image to InvokeAI and use it as a reference image">'
    f'{_USE_REF_SVG}<span class="invoke-recall-label">Use as Ref Image</span>'
    '<span class="invoke-recall-status" aria-live="polite"></span>'
    "</button>"
)


def _recall_buttons_html() -> str:
    """Render the recall / remix / use-ref button group shown at the bottom of the drawer."""
    return (
        '<div class="invoke-recall-controls" data-invoke-recall="1">'
        '<button type="button" class="invoke-recall-btn" data-recall-mode="remix" '
        'title="Remix (recall parameters without the seed) to InvokeAI">'
        f'{_REMIX_SVG}<span class="invoke-recall-label">Remix</span>'
        '<span class="invoke-recall-status" aria-live="polite"></span>'
        "</button>"
        '<button type="button" class="invoke-recall-btn" data-recall-mode="recall" '
        'title="Recall parameters (including seed) to InvokeAI">'
        f'{_RECALL_SVG}<span class="invoke-recall-label">Recall</span>'
        '<span class="invoke-recall-status" aria-live="polite"></span>'
        "</button>"
        f"{_USE_REF_BUTTON_HTML}"
        "</div>"
    )


def use_ref_button_html() -> str:
    """Render the standalone "Use as Ref Image" button.

    The Recall and Remix buttons need recallable InvokeAI generation parameters
    in the image metadata, but "Use as Ref Image" only needs the image itself —
    so it is appended to non-Invoke metadata views as well, whenever an
    InvokeAI backend is configured.
    """
    return (
        '<div class="invoke-recall-controls" data-invoke-recall="1">'
        f"{_USE_REF_BUTTON_HTML}"
        "</div>"
    )


def format_invoke_metadata(
    slide_data: SlideSummary,
    metadata: dict,
    show_recall_buttons: bool = False,
) -> SlideSummary:
    """Render InvokeAI metadata into an HTML table on ``slide_data.description``.

    Also populates ``slide_data.reference_images`` with the image names of any
    reference images, control layer images, and raster images referenced by
    the metadata — these are used by the drawer to render thumbnails.
    """
    if not metadata:
        slide_data.description = "<i>No invoke metadata available.</i>"
        return slide_data

    # Images produced by custom Invoke workflows sometimes carry a flat dict
    # of hand-picked scalars. Render those as a plain key/value table.
    if all(
        isinstance(value, str | int | float | bool | type(None))
        for value in metadata.values()
    ):
        slide_data.description = _scalar_table(metadata) + (
            use_ref_button_html() if show_recall_buttons else ""
        )
        return slide_data

    try:
        parsed = GenerationMetadataAdapter().parse(metadata)
    except ValidationError as exc:
        logger.warning("Failed to parse invoke metadata: %s", exc)
        slide_data.description = "<i>Unknown invoke metadata format.</i>" + (
            use_ref_button_html() if show_recall_buttons else ""
        )
        return slide_data

    view = InvokeMetadataView(parsed)

    modification_time = _format_mtime(slide_data.filepath)
    positive_prompt = view.positive_prompt
    negative_prompt = view.negative_prompt
    model = view.model_name
    seed = view.seed
    loras = view.loras
    reference_images = view.reference_images
    control_layers = view.control_layers
    raster_images = view.raster_images

    rows: list[str] = []
    if modification_time:
        rows.append(f"<tr><th>Date</th><td>{modification_time}</td></tr>")
    rows.append(
        f'<tr><th>Positive Prompt</th><td class="copyme">'
        f"{positive_prompt}{_COPY_SVG if positive_prompt else ''}</td></tr>"
    )
    if negative_prompt:
        rows.append(
            f'<tr><th>Negative Prompt</th><td class="copyme">'
            f"{negative_prompt}{_COPY_SVG}</td></tr>"
        )
    if model:
        rows.append(f"<tr><th>Model</th><td>{model}</td></tr>")
    if seed is not None:
        rows.append(
            f'<tr><th>Seed</th><td class="copyme">{seed}{_COPY_SVG}</td></tr>'
        )
    if loras and (lora_html := _tuple_table(loras)):
        rows.append(f"<tr><th>Loras</th><td>{lora_html}</td></tr>")
    if raster_images:
        rows.append(
            f"<tr><th>Raster Images</th><td>{', '.join(raster_images)}</td></tr>"
        )
    if reference_images and (ref_html := _tuple_table(reference_images)):
        rows.append(f"<tr><th>Reference Images</th><td>{ref_html}</td></tr>")
    if control_layers and (ctrl_html := _tuple_table(control_layers)):
        rows.append(f"<tr><th>Control Layers</th><td>{ctrl_html}</td></tr>")

    slide_data.description = (
        "<table class='invoke-metadata'>"
        + "".join(rows)
        + "</table>"
        + (_recall_buttons_html() if show_recall_buttons else "")
    )
    slide_data.reference_images = [
        ri.image_name for ri in reference_images if ri.image_name
    ] + [
        cl.image_name for cl in control_layers if cl.image_name
    ] + list(raster_images)
    return slide_data


def _scalar_table(metadata: dict) -> str:
    rows = "".join(
        f"<tr><th>{key}</th><td>{value}</td></tr>" for key, value in metadata.items()
    )
    return f"<table class='invoke-metadata'>{rows}</table>"


def _format_mtime(filepath: str | None) -> str | None:
    if not filepath:
        return None
    try:
        mtime = Path(filepath).stat().st_mtime
    except (OSError, ValueError):
        return None
    return datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M:%S")


def _tuple_table(
    tuples: Iterable[LoraTuple | ReferenceImageTuple | ControlLayerTuple],
) -> str:
    """Render a list of named tuples as a compact HTML table.

    Suppression rules:

    * **Row** — a row whose every field is empty (``None`` or ``""``) is dropped.
    * **Column** — a column that is empty across *all* surviving rows is
      dropped entirely, so a table of reference images with no IP adapter
      model names, for example, renders without a model column at all.
    * **Weight fallback** — when the ``weight`` column survives because at
      least one row carries a weight, rows that are missing a weight are
      rendered as ``1.0`` (the effective default InvokeAI uses when the
      field is absent) rather than as a ragged empty cell.
    """
    rows_data = [
        tup
        for tup in tuples
        if not all(v is None or v == "" for v in tup)
    ]
    if not rows_data:
        return ""

    fields = rows_data[0]._fields
    keep_column = [
        any(tup[idx] is not None and tup[idx] != "" for tup in rows_data)
        for idx in range(len(fields))
    ]

    html_rows: list[str] = []
    for tup in rows_data:
        cells: list[str] = []
        for idx, field_name in enumerate(fields):
            if not keep_column[idx]:
                continue
            value = tup[idx]
            if field_name == "weight" and (value is None or value == ""):
                value = 1.0
            elif value is None:
                value = ""
            cells.append(f"<td>{value}</td>")
        html_rows.append(f"<tr>{''.join(cells)}</tr>")

    return "<table class='invoke-tuples'>" + "".join(html_rows) + "</table>"
