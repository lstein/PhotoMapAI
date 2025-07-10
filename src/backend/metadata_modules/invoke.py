"""
backend.metadata_modules.invoke

Format metadata from invoke module, including human-readable tags.
Returns an HTML representation of the metadata. 
"""

def format_invoke_metadata(metadata: dict) -> str:
    """
    Format invoke metadata dictionary into an HTML string.
    
    Args:
        metadata (dict): Metadata dictionary containing invoke attributes.
        
    Returns:
        str: HTML representation of the invoke metadata.
    """
    if not metadata:
        return "<i>No invoke metadata available.</i>"
    
    positive_prompt = metadata.get('positive_prompt', '') if 'positive_prompt' in metadata \
        else metadata['image'].get('positive_prompt', '') if 'image' in metadata \
             else ''
    negative_prompt = metadata.get('negative_prompt', '') if 'negative_prompt' in metadata else ''

    # get the model using the various ways it might be stored in metadata
    model = metadata['model']['model_name'] if 'model' in metadata and 'model_name' in metadata['model'] \
        else metadata['model']['name'] if 'model' in metadata and 'name' in metadata['model'] \
             else metadata['model_weights'] if 'model_weights' in metadata \
                else metadata.get('model', '')
    
    # get the seed for the generation
    seed = metadata['seed'] if 'seed' in metadata \
        else metadata.get('image', {}).get('seed', None)
    
    loras = _format_loras(metadata.get('loras', []))
    ipadapters = _format_ipadapters(metadata.get('canvas_v2_metadata', {})) if 'canvas_v2_metadata' in metadata \
        else _format_ipadapters(metadata.get('ipAdapters', []))
    
    html = "<table class='invoke-metadata'>"
    html += f"<tr><th>Positive Prompt</th><td>{positive_prompt}</td></tr>"
    if negative_prompt:
        html += f"<tr><th>Negative Prompt</th><td>{negative_prompt}</td></tr>"
    if model:
        html += f"<tr><th>Model</th><td>{model}</td></tr>"
    if seed is not None:
        html += f"<tr><th>Seed</th><td>{seed}</td></tr>"
    if loras:
        html += f"<tr><th>Loras</th><td>{loras}</td></tr>"
    if ipadapters:
        html += f"<tr><th>IPAdapters</th><td>{ipadapters}</td></tr>"
    html += "</table>"
    
    return html

def _format_loras(loras: list) -> str | None:
    """    Format a list of loras into an HTML table.
    Args:
        loras (list): List of lora dictionaries.
    Returns:
        str: HTML representation of the loras.
    """
    if not loras:
        return
    
    html = "<table class='loras'>"
    for lora in loras:
        name = lora.get('model', {}).get('name', 'Unknown Lora') if 'model' in lora \
            else lora.get('lora', {}).get('model_name', 'Unknown Lora')
        weight = lora.get('weight', '1.0')
        html += f"<tr><th>{name}</th><td>Weight: {weight}</td></tr>"
    html += "</table>"
    
    return html

def _format_ipadapters(ipadapters: list[dict]) -> str | None:
    """Format a list of ipadapters into an HTML table.
    
    Args:
        ipadapters (list): List of ipadapter dictionaries.
        
    Returns:
        str: HTML representation of the ipadapters.
    """
    if not ipadapters:
        return
    
    html = "<table class='ipadapters'>"

    if 'referenceImages' in ipadapters:
        for image in ipadapters['referenceImages']:
            adapter = image.get('ipAdapter')
            if not adapter:
                continue
            model = adapter.get('model',{}).get('name','Unknown Model')
            weight = adapter.get('weight', '1.0')
            image_data = adapter.get('image')
            if not image_data:
                continue
            image_name = image_data.get('image_name', 'Unknown Reference Image')
            html += f"<tr><th>{model}</th><td>{image_name}</td></td>{weight}</td></tr>"
    else:
        for adapter in ipadapters:
            image_name = adapter.get('image', {}).get('image_name', 'Unknown Reference Image')
            model = adapter.get('ip_adapter_model', {}).get('model_name', 'Unknown Model')
            weight = adapter.get('weight', '1.0')
            html += f"<tr><th>{model}</th><td>{image_name}</td><td>{weight}</td></tr>"
    html += "</table>"
    
    return html 
