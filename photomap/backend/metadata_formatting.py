"""
backend.metadata.py

Format metadata for images, including EXIF data and other attributes.
Returns an HTML representation of the metadata.
"""

import logging
from pathlib import Path

from .config import get_config_manager
from .metadata_modules import (
    SlideSummary,
    format_exif_metadata,
    format_invoke_metadata,
    use_ref_button_html,
)

logger = logging.getLogger(__name__)


def format_metadata(
    filepath: Path, metadata: dict, index: int, total_slides: int
) -> SlideSummary:
    """
    Format metadata dictionary into an HTML string.

    Args:
        filepath (Path): Path to the file.
        metadata (dict): Metadata dictionary containing image attributes.

    Returns:
        SlideMetadata: structured representation of the metadata.
    """
    result = SlideSummary(
        filename=filepath.name,
        filepath=filepath.as_posix(),
        index=index,
        total=total_slides,
    )

    config_manager = get_config_manager()
    invokeai_configured = bool(config_manager.get_invokeai_settings().get("url"))

    # The "Use as Ref Image" button only needs an image to upload — it works
    # for any file regardless of metadata. The full Recall/Remix group, on the
    # other hand, requires recallable Invoke generation parameters and is
    # rendered by ``format_invoke_metadata`` itself.
    is_invoke_metadata = bool(metadata) and (
        "app_version" in metadata
        or "generation_mode" in metadata
        or "canvas_v2_metadata" in metadata
    )

    if not metadata:
        result.description = "<i>No metadata available.</i>"
    elif is_invoke_metadata:
        return format_invoke_metadata(
            result, metadata, show_recall_buttons=invokeai_configured
        )
    else:
        api_key = config_manager.get_locationiq_api_key()
        result = format_exif_metadata(result, metadata, api_key)

    if invokeai_configured:
        result.description = (result.description or "") + use_ref_button_html()
    return result
