"""
Pydantic class for slide metadata.
This class is used to represent metadata for a slide, including filename, filepath, description, URL
"""

from pydantic import BaseModel


class SlideMetadata(BaseModel):
    """
    Model to represent metadata for a slide.
    """

    filename: str
    filepath: str
    description: str = ""
    url: str = ""
    textToCopy: str = ""
