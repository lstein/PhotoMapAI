"""
backend.metadata.exif

Format EXIF metadata for images, including human-readable tags.
Returns an HTML representation of the EXIF data.
"""

from pathlib import Path
from slide_metadata import SlideMetadata

def format_exif_metadata(slide_data: SlideMetadata, metadata: dict) -> SlideMetadata:
    """
    Format EXIF metadata dictionary into an HTML string.
    
    Args:
        filepath (Path): Path to the file.
        metadata (dict): Metadata dictionary containing EXIF attributes.
        
    Returns:
        SlideMetadata: structured metadata appropriate for an image with EXIF data.
    """

    if not metadata:
        slide_data.description = "<i>No EXIF metadata available.</i>"
        return slide_data
    
    html = "<table class='exif-metadata'>"
    for tag, value in metadata.items():
        html += f"<tr><th>{tag}</th><td>{value}</td></tr>"
    html += "</table>"
    
    slide_data.description = html
    slide_data.textToCopy = filepath.name
    return slide_data
