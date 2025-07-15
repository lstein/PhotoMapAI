"""
metadata.py
Parse metadata from the legacy (pre v3.0) InvokeAI format.
"""
from typing import List
from .invoke_metadata_abc import InvokeMetadataABC, Prompts, Lora, ReferenceImage, ControlLayer


class InvokeLegacyMetadata(InvokeMetadataABC):
    def get_prompts(self) -> Prompts:
        """
        Extract positive and negative prompts from the raw metadata.
        
        Returns:
            Prompts: A named tuple containing positive and negative prompts.
        """
        return Prompts(
            positive_prompt=self.raw_metadata.get('image',{}).get('prompt', ''),
            negative_prompt=''
        )
    
    def get_model(self) -> str:
        """
        Extract the model name from the raw metadata.
        Returns:
            str: The name of the model used for generation.
        """
        return self.raw_metadata.get('model_weights', '') or self.raw_metadata.get('model', 'Unknown Model')
    
    def get_seed(self) -> int:
        """
        Extract the seed used for generation from the raw metadata.
        Returns:
            int: The seed value.
        """
        return self.raw_metadata.get('image',{}).get('seed', 0)
    
    def get_loras(self) -> List[Lora]:
        """
        Extract Lora information from the raw metadata.
        Returns:
            List[Lora]: A list of Lora named tuples containing name and weight.
        """
        return []  # no Lora support in legacy metadata
    
    def get_reference_images(self) -> List[ReferenceImage]:
        """
        Extract reference image (IPAdapter) information from the raw metadata.
        Returns:
            List[ReferenceImage]: A list of ReferenceImage named tuples containing model_name, reference image, and weight.
        """
        return []  # no IPAdapter support in legacy metadata
        
    def get_control_layers(self) -> List[ControlLayer]:
        """
        Extract control layer information from the raw metadata.
        
        Returns:
            List[ControlLayer]: A list of ControlLayer named tuples containing layer_type, reference, and weight.
        """
        return []   # no control layer support in legacy metadata
    