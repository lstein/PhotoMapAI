"""
backend.metadata.py

Format metadata for images, including EXIF data and other attributes.
Returns an HTML representation of the metadata.
"""

import logging
from pathlib import Path

from .config import get_config_manager
from .media_types import media_type_for
from .metadata_modules import (
    SlideSummary,
    format_exif_metadata,
    format_invoke_metadata,
    format_video_metadata,
    use_ref_button_html,
)
from .video import VIDEO_METADATA_KEY

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

    # Videos branch first and return early. Two reasons this cannot just fall
    # through to the EXIF path: the video facts live under a reserved key that
    # would otherwise render as a raw dict row, and the "Use as Ref Image"
    # button below uploads the file to InvokeAI as a reference image — handing
    # it an .mkv is a live bug, so videos never get that button.
    if media_type_for(filepath) == "video":
        result.media_type = "video"
        video_info = metadata.get(VIDEO_METADATA_KEY) if metadata else None
        result.video_info = video_info
        result = format_video_metadata(result, video_info)

        # Phone videos routinely carry a creation date and GPS, so any
        # non-video metadata still gets the normal EXIF panel underneath.
        remaining = {
            k: v for k, v in (metadata or {}).items() if k != VIDEO_METADATA_KEY
        }
        if remaining:
            api_key = config_manager.get_locationiq_api_key()
            exif_only = format_exif_metadata(
                SlideSummary(filename=result.filename, filepath=result.filepath),
                remaining,
                api_key,
            )
            result.description += exif_only.description
        return result

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
