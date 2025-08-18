"""
Support for metadata extraction from images created with InvokeAI v3.
"""

from logging import getLogger
from typing import List

from .invoke_metadata_abc import (
    ControlLayer,
    InvokeMetadataABC,
    Lora,
    Prompts,
    ReferenceImage,
)

logger = getLogger(__name__)


class Invoke3Metadata(InvokeMetadataABC):
    def get_prompts(self) -> Prompts:
        """
        Extract positive and negative prompts from the raw metadata.

        Returns:
            Prompts: A named tuple containing positive and negative prompts.
        """
        return Prompts(
            positive_prompt=self.raw_metadata.get("positive_prompt", ""),
            negative_prompt=self.raw_metadata.get("negative_prompt", ""),
        )

    def get_model(self) -> str:
        """
        Extract the model name from the raw metadata.

        Returns:
            str: The name of the model used for generation.
        """
        return self.raw_metadata.get("model", {}).get(
            "name", ""
        ) or self.raw_metadata.get("model", {}).get("model_name", "")

    def get_seed(self) -> int:
        """
        Extract the seed used for generation from the raw metadata.

        Returns:
            int: The seed value.
        """
        return self.raw_metadata.get("seed", 0)

    def get_loras(self) -> List[Lora]:
        """
        Extract Lora information from the raw metadata.

        Returns:
            List[Lora]: A list of Lora named tuples containing name and weight.
        """
        loras = self.raw_metadata.get("loras", [])
        return [
            (
                Lora(
                    model_name=lora.get("lora", {}).get("model_name", "Unknown Lora"),
                    weight=lora.get("weight", 1.0),
                )
                if "lora" in lora
                else Lora(
                    model_name=lora.get("model", {}).get("name", "Unknown Lora"),
                    weight=lora.get("weight", "1.0"),
                )
            )
            for lora in loras
        ]

    def get_reference_images(self) -> List[ReferenceImage]:
        """
        Extract reference image (IPAdapter) information from the raw metadata.

        Returns:
            List[ReferenceImage]: A list of ReferenceImage named tuples containing model_name, reference image name, and weight.
        """
        reference_images = self.raw_metadata.get("ipAdapters", [])
        return [
            ReferenceImage(
                model_name=image.get("ip_adapter_model", {}).get("model_name"),
                image_name=image.get("image", {}).get("image_name", ""),
                weight=image.get("weight", 1.0),
            )
            for image in reference_images
        ]

    def get_control_layers(self) -> List[ControlLayer]:
        """
        Extract control layer information from the raw metadata.

        Returns:
            List[ControlLayer]: A list of ControlLayer named tuples containing layer_type, reference, and weight.
        """
        control_layers = self.raw_metadata.get("controlnets", [])
        if not control_layers:
            return []
        return [
            ControlLayer(
                model_name=layer.get("control_model", {}).get("model_name")
                or layer.get("control_model", {}).get("name", "Unknown Model"),
                image_name=layer.get("image", {}).get("image_name", ""),
                weight=layer.get("control_weight", 1.0),
            )
            for layer in control_layers
        ]

    def get_raster_images(self) -> List[str]:
        """
        Extract raster image information from the raw metadata.

        Returns:
            List[str]: A list of raster image names.
        """
        return []  # not yet supported for older Invoke versions
