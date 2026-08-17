"""
backend.metadata.py

Format metadata for images, including EXIF data and other attributes.
Returns an HTML representation of the metadata.
"""

import logging
import math
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


def _sanitized_video_info(metadata: dict | None) -> dict | None:
    """The probe dict, made safe to put on a JSON response model.

    Three problems this closes, all of which surface as a 500 on
    ``/retrieve_image`` — i.e. a blank slideshow, not a missing field:

    * The value is whatever is in the ``.npz``. A non-dict (a JSON *string*,
      say, from a hand-edited or older index) makes the formatter's ``.get``
      raise ``AttributeError``.
    * Non-finite floats are reachable, because the banner parser's numeric
      patterns match arbitrarily long digit runs and ``float("9" * 400)`` is
      ``inf``. Starlette serializes with ``allow_nan=False``, so an ``inf``
      here 500s the response *even if* every formatter handles it — the two
      are independent failure sites.
    * The dict handed over belongs to the ``lru_cache``d index; assigning it
      straight onto the response model shares mutable state with the
      process-wide cache. Copying breaks that aliasing.
    """
    if not metadata:
        return None
    raw = metadata.get(VIDEO_METADATA_KEY)
    if not isinstance(raw, dict):
        return None

    clean: dict = {}
    for key, value in raw.items():
        if isinstance(value, float) and not math.isfinite(value):
            continue
        clean[key] = value
    return clean


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
        video_info = _sanitized_video_info(metadata)
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
