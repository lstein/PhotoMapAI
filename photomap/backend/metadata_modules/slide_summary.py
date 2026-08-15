"""
Pydantic class for slide metadata.
This class is used to represent metadata for a slide, including filename, filepath, description, URL
"""

from typing import Literal

from pydantic import BaseModel


class SlideSummary(BaseModel):
    """
    Model to represent name and descriptive information for a slide.
    """

    filename: str
    filepath: str
    description: str = ""
    image_url: str = ""
    metadata_url: str = ""
    index: int = 0
    total: int = 0
    reference_images: list[str] = []

    # Media-type fields. The defaults keep every payload for a still image
    # byte-identical to what it was before videos existed, so the frontend
    # only needs to look at ``media_type`` where it actually cares.
    media_type: Literal["image", "video"] = "image"
    # Where the playable bytes live, for videos. ``image_url`` still points at
    # something displayable — the extracted still — so existing consumers that
    # just want a picture keep working unchanged.
    video_url: str = ""
    # Duration / fps / resolution / codec / container, when known.
    video_info: dict | None = None
