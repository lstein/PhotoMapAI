"""
backend.metadata_modules.invoke_formatter

Format metadata from invoke module, including human-readable tags.
Returns an HTML representation of the metadata. 
"""
from pathlib import Path
from typing import List, Any
from .slide_summary import SlideSummary
from .invoke import InvokeLegacyMetadata, Invoke3Metadata, Invoke5Metadata

def format_invoke_metadata(slide_data: SlideSummary, metadata: dict) -> SlideSummary:
    """
    Format invoke metadata dictionary into an HTML string.
    
    Args:
        slide_data: SlideSummary containing the file name and path.
        metadata (dict): Metadata dictionary containing invoke attributes.
        
    Returns:
        SlideSummary: structured metadata appropriate for an image with invoke data.
    """
    if not metadata:
        slide_data.description = "<i>No invoke metadata available.</i>"
        return slide_data
    
    # pick the appropriate metadata class based on tags in the raw data
    extractor_class = InvokeLegacyMetadata if 'app_version' in metadata \
        else Invoke3Metadata if 'generation_mode' in metadata \
        else Invoke5Metadata if 'canvas_v2_metadata' in metadata \
        else None
    
    if not extractor_class:
        slide_data.description = "<i>Unknown invoke metadata format.</i>"
        return slide_data
    
    extractor = extractor_class(raw_metadata=metadata)
    positive_prompt = extractor.get_prompts().positive_prompt
    negative_prompt = extractor.get_prompts().negative_prompt
    model = extractor.get_model()
    seed = extractor.get_seed()
    loras = _format_list(extractor.get_loras())
    reference_images = _format_list(extractor.get_reference_images())
    control_layers = _format_list(extractor.get_control_layers())

    
    html = "<table class='invoke-metadata'>"
    if positive_prompt:
        html += f"<tr><th>Positive Prompt</th><td>{positive_prompt}</td></tr>"
    if negative_prompt:
        html += f"<tr><th>Negative Prompt</th><td>{negative_prompt}</td></tr>"
    if model:
        html += f"<tr><th>Model</th><td>{model}</td></tr>"
    if seed is not None:
        html += f"<tr><th>Seed</th><td>{seed}</td></tr>"
    if loras:
        html += f"<tr><th>Loras</th><td>{loras}</td></tr>"
    if reference_images:
        html += f"<tr><th>IPAdapters</th><td>{reference_images}</td></tr>"
    if control_layers:
        html += f"<tr><th>Control Layers</th><td>{control_layers}</td></tr>"
    html += "</table>"
    
    slide_data.description = html
    slide_data.textToCopy = positive_prompt if positive_prompt else slide_data.filepath
    return slide_data

def _format_list(tuples: List[Any]) -> str | None:
    """    
    Format a list of tuples into an HTML table.
    Args:
        tuples (list): List of tuples, such as the Lora tuple defined in invoke_metadata_abc.
    Returns:
        str: HTML representation of the loras.
    """
    if not tuples:
        return
    
    html = "<table class='invoke-tuples'>"
    for tuple in tuples:
        row = "".join([f"<td>{item}</td>" for item in tuple])
        html += f"<tr>{row}</tr>"
    html += "</table>"
    return html
