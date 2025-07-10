"""
backend.metadata.exif

Format EXIF metadata for images, including human-readable tags.
Returns an HTML representation of the EXIF data.
"""

def format_exif_metadata(metadata: dict) -> str:
    """
    Format EXIF metadata dictionary into an HTML string.
    
    Args:
        metadata (dict): Metadata dictionary containing EXIF attributes.
        
    Returns:
        str: HTML representation of the EXIF metadata.
    """
    if not metadata:
        return "<i>No EXIF metadata available.</i>"
    
    html = "<table class='exif-metadata'>"
    for tag, value in metadata.items():
        html += f"<tr><th>{tag}</th><td>{value}</td></tr>"
    html += "</table>"
    
    return html
