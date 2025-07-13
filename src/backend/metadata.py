"""
backend.metadata.py

Format metadata for images, including EXIF data and other attributes.
Returns an HTML representation of the metadata.
"""
from pathlib import Path
from pydantic import BaseModel
from .metadata_modules import format_invoke_metadata, format_exif_metadata, SlideMetadata

def format_metadata(filepath: Path, metadata: dict) -> SlideMetadata:
    """
    Format metadata dictionary into an HTML string.
    
    Args:
        filepath (Path): Path to the file.
        metadata (dict): Metadata dictionary containing image attributes.
        
    Returns:
        SlideMetadata: structured representation of the metadata.
    """
    result = SlideMetadata(
        filename=filepath.name,
        filepath=filepath.as_posix()
    )   
    if not metadata:
        result.description = "<i>No metadata available.</i>"
        return result
    
    if 'model_weights' in metadata or 'generation_mode' in metadata:
        return format_invoke_metadata(result, metadata)
    else:
        return format_exif_metadata(result, metadata)
    
