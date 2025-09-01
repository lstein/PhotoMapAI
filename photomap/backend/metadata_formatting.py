"""
backend.metadata.py

Format metadata for images, including EXIF data and other attributes.
Returns an HTML representation of the metadata.
"""

import logging
from pathlib import Path

from pydantic import BaseModel

from .config import get_config_manager
from .metadata_modules import SlideSummary, format_exif_metadata, format_invoke_metadata

config_manager = get_config_manager()
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
    if not metadata:
        result.description = "<i>No metadata available.</i>"
        return result

    # This is a fragile heuristic. Better to infer the type of metadata when the embeddings are
    # created, but this is a quick fix to avoid breaking existing metadata.
    if (
        "app_version" in metadata
        or "generation_mode" in metadata
        or "canvas_v2_metadata" in metadata
    ):
        return format_invoke_metadata(result, metadata)
    else:
        api_key = config_manager.get_locationiq_api_key()
        return format_exif_metadata(result, metadata, api_key)
