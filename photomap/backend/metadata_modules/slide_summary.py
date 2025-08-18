"""
Pydantic class for slide metadata.
This class is used to represent metadata for a slide, including filename, filepath, description, URL
"""

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
