"""
Abstract base class for Invoke metadata modules.
This class is used to define the interface for formatting metadata from Invoke modules.
"""

from abc import ABC, abstractmethod
from collections import namedtuple
from pathlib import Path
from typing import Any, Dict, List

from pydantic import BaseModel

Prompts = namedtuple("Prompts", ["positive_prompt", "negative_prompt"])
Lora = namedtuple("Lora", ["model_name", "weight"])
ReferenceImage = namedtuple("ReferenceImage", ["model_name", "image_name", "weight"])
ControlLayer = namedtuple("ControlLayer", ["model_name", "image_name", "weight"])
RasterImage = namedtuple("RasterImage", ["model_name", "image_name", "weight"])


class InvokeMetadataABC(BaseModel, ABC):
    """
    Abstract base class for formatting Invoke metadata.
    """

    raw_metadata: Dict[str, Any] = {}

    @abstractmethod
    def get_prompts(self) -> Prompts:
        """
        Extract positive and negative prompts from the raw metadata.

        Returns:
            Prompts: A named tuple containing positive and negative prompts.
        """
        pass

    @abstractmethod
    def get_model(self) -> str:
        """
        Extract the model name from the raw metadata.

        Returns:
            str: The name of the model used for generation.
        """
        pass

    @abstractmethod
    def get_seed(self) -> int:
        """
        Extract the seed used for generation from the raw metadata.

        Returns:
            int: The seed value.
        """
        pass

    @abstractmethod
    def get_loras(self) -> List[Lora]:
        """
        Extract Lora information from the raw metadata.

        Returns:
            List[Lora]: A list of Lora named tuples containing name and weight.
        """
        pass

    @abstractmethod
    def get_reference_images(self) -> List[ReferenceImage]:
        """
        Extract reference image (IPAdapter) information from the raw metadata.

        Returns:
            List[ReferenceImage]: A list of ReferenceImage named tuples containing model_name, reference image, and weight.
        """
        pass

    @abstractmethod
    def get_raster_images(self) -> List[str]:
        """
        Extract raster image information from the raw metadata.

        Returns:
            List[str]: A list of raster image names.
        """
        pass

    # TO DO: Support regional guidance in Invoke metadata.
    # @abstractmethod
    # def get_regional_guidance(self) -> List[RegionalGuidance]:
    #     """
    #     Extract regional guidance information from the raw metadata.

    #     Returns:
    #         List[RegionalGuidance]: A list of RegionalGuidance named tuples containing guidance_type, reference, and weight.

    #     guidance_type is one of "positive_prompt", "negative_prompt", or "image".
    #     reference is the corresponding prompt or image.
    #     weight is the weight of the guidance.
    #     """
    #     pass

    @abstractmethod
    def get_control_layers(self) -> List[ControlLayer]:
        """
        Extract control layer information from the raw metadata.

        Returns:
            List[ControlLayer]: A list of ControlLayer named tuples containing model_name, reference_image, and weight.
        """
        pass
