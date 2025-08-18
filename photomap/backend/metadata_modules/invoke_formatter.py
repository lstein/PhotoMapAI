"""
backend.metadata_modules.invoke_formatter

Format metadata from invoke module, including human-readable tags.
Returns an HTML representation of the metadata.
"""

import logging
from datetime import datetime
from pathlib import Path
from typing import Any, List

from .invoke import Invoke3Metadata, Invoke5Metadata, InvokeLegacyMetadata
from .slide_summary import SlideSummary

logger = logging.getLogger(__name__)


def format_invoke_metadata(slide_data: SlideSummary, metadata: dict) -> SlideSummary:
    """
    Format invoke metadata dictionary into an HTML string.

    Args:
        slide_data: SlideSummary containing the file name and path.
        metadata (dict): Metadata dictionary containing invoke attributes.

    Returns:
        SlideSummary: structured metadata appropriate for an image with invoke data.
    """
    if not metadata:
        slide_data.description = "<i>No invoke metadata available.</i>"
        return slide_data

    # pick the appropriate metadata class based on tags in the raw data
    extractor_class = (
        Invoke5Metadata
        if "canvas_v2_metadata" in metadata
        else (
            Invoke3Metadata
            if "generation_mode" in metadata
            else InvokeLegacyMetadata if "app_version" in metadata else None
        )
    )

    # get modification time for the file
    modification_time = None
    if mtime := (
        Path(slide_data.filepath).stat().st_mtime if slide_data.filepath else None
    ):
        modification_time = datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M:%S")

    if not extractor_class:
        slide_data.description = "<i>Unknown invoke metadata format.</i>"
        return slide_data

    extractor = extractor_class(raw_metadata=metadata)
    positive_prompt = extractor.get_prompts().positive_prompt
    negative_prompt = extractor.get_prompts().negative_prompt
    model = extractor.get_model()
    seed = extractor.get_seed()
    loras = _format_list(extractor.get_loras())
    reference_images = extractor.get_reference_images()
    reference_image_table = _format_list(reference_images) if reference_images else None
    raster_images = extractor.get_raster_images()
    control_layers = extractor.get_control_layers()
    control_layer_table = _format_list(control_layers) if control_layers else None

    copy_svg = (
        '<span class="copy-icon" title="Copy">'
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:middle;">'
        '<path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>'
        "</svg></span>"
    )

    html = "<table class='invoke-metadata'>"
    if modification_time:
        html += f"<tr><th>Date</th><td>{modification_time}</td></tr>"
    if positive_prompt:
        html += f'<tr><th>Positive Prompt</th><td class="copyme">{positive_prompt}{copy_svg}</td></tr>'
    if negative_prompt:
        html += f'<tr><th>Negative Prompt</th><td class="copyme">{negative_prompt}{copy_svg}</td></tr>'
    if model:
        html += f"<tr><th>Model</th><td>{model}</td></tr>"
    if seed is not None:
        html += f'<tr><th>Seed</th><td class="copyme">{seed}{copy_svg}</td></tr>'
    if loras:
        html += f"<tr><th>Loras</th><td>{loras}</td></tr>"
    if raster_images:
        html += f"<tr><th>Raster Images</th><td>{', '.join(raster_images)}</td></tr>"
    if reference_image_table:
        html += f"<tr><th>IPAdapters</th><td>{reference_image_table}</td></tr>"
    if control_layer_table:
        html += f"<tr><th>Control Layers</th><td>{control_layer_table}</td></tr>"
    html += "</table>"

    slide_data.description = html
    slide_data.reference_images = [
        x.image_name for x in reference_images + control_layers
    ]
    slide_data.reference_images.extend(raster_images)
    return slide_data


def _format_list(tuples: List[Any]) -> str | None:
    """
    Format a list of tuples into an HTML table.
    Args:
        tuples (list): List of tuples, such as the Lora tuple defined in invoke_metadata_abc.
    Returns:
        str: HTML representation of the loras.
    """
    if not tuples:
        return

    html = "<table class='invoke-tuples'>"
    for tuple in tuples:
        row = "".join([f"<td>{item}</td>" for item in tuple])
        html += f"<tr>{row}</tr>"
    html += "</table>"
    return html
