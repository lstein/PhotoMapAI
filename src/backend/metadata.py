"""
backend.metadata.py

Format metadata for images, including EXIF data and other attributes.
Returns an HTML representation of the metadata.
"""
from .metadata_modules.invoke import format_invoke_metadata
from .metadata_modules.exif import format_exif_metadata

def format_metadata(metadata: dict) -> str:
    """
    Format metadata dictionary into an HTML string.
    
    Args:
        metadata (dict): Metadata dictionary containing image attributes.
        
    Returns:
        str: HTML representation of the metadata.
    """
    if not metadata:
        return "<i>No metadata available.</i>"
    if 'model_weights' in metadata or 'generation_mode' in metadata:
        return format_invoke_metadata(metadata)
    else:
        return format_exif_metadata(metadata)
    
