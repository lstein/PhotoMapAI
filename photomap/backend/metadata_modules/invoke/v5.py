"""
Extract Invoke5 metadata from the raw metadata dictionary.
"""

"""
Support for metadata extraction from images created with InvokeAI v3.
"""

from typing import List

from .invoke_metadata_abc import (
    ControlLayer,
    InvokeMetadataABC,
    Lora,
    Prompts,
    ReferenceImage,
)


class Invoke5Metadata(InvokeMetadataABC):
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
        return self.raw_metadata.get("model", {}).get("name", "")

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
            Lora(
                model_name=lora.get("model", {}).get("name", "Unknown Lora"),
                weight=lora.get("weight", 1.0),
            )
            for lora in loras
            if "lora" in lora
        ]

    def get_reference_images(self) -> List[ReferenceImage]:
        """
        Extract reference image (IPAdapter) information from the raw metadata.

        Returns:
            List[ReferenceImage]: A list of ReferenceImage named tuples containing model_name, reference image, and weight.
        """
        return (
            self._get_reference_images()
            if "ref_images" in self.raw_metadata
            else (
                self._get_reference_images_from_canvas_v2()
                if "canvas_v2_metadata" in self.raw_metadata
                else []
            )
        )

    def _get_reference_images(self) -> List[ReferenceImage]:
        """
        This is called to get the reference image when the metadata contains a ref_images field.
        """
        reference_images = self.raw_metadata.get("ref_images", [])
        return [
            ReferenceImage(
                model_name=image.get("config", {})
                .get("model", {})
                .get("name", "Unknown Model"),
                image_name=image.get("config", {})
                .get("image", {})
                .get("image_name", ""),
                weight=image.get("config", {}).get("weight", 1.0),
            )
            for image in reference_images
            if image.get("isEnabled", False)
        ]

    def _get_reference_images_from_canvas_v2(self) -> List[ReferenceImage]:
        """
        This is called to get the reference image when the metadata contains a canvas_v2_metadata field,
        and not the "ref_images" tag.
        """
        reference_images = self.raw_metadata.get("canvas_v2_metadata", {}).get(
            "referenceImages", []
        )
        return [
            ReferenceImage(
                model_name=image.get("ipAdapter", {})
                .get("model", {})
                .get("name", "Unknown Model"),
                image_name=image.get("ipAdapter", {})
                .get("image", {})
                .get("image_name", ""),
                weight=image.get("ipAdapter", {}).get("weight", 1.0),
            )
            for image in reference_images
            if image.get("isEnabled", False)
        ]

    def get_control_layers(self) -> List[ControlLayer]:
        """
        Extract control layer information from the raw metadata.
        Returns:
            List[ControlLayer]: A list of ControlLayer named tuples containing model_name, reference_image, and weight.
        """
        return (
            self._get_control_layers()
            if "controlLayers" in self.raw_metadata
            else (
                self._get_control_layers_from_canvas_v2()
                if "canvas_v2_metadata" in self.raw_metadata
                else []
            )
        )

    def get_raster_images(self) -> List[str]:
        """
        Extract raster image information from the raw metadata.
        """
        raster_layers = self.raw_metadata.get("canvas_v2_metadata", {}).get(
            "rasterLayers", []
        )
        result = []
        if not raster_layers:
            return result
        # Iterate through each raster layer and extract images
        for layer in raster_layers:
            if not layer.get("isEnabled", False):
                continue
            images = [
                object.get("image", {}).get("image_name", "Unknown Image")
                for object in layer.get("objects", [])
            ]
            result.extend(images)
        return result

    def _get_control_layers(self) -> List[ControlLayer]:
        """
        This is called to get the control layers when the metadata contains a controlLayers field.
        """
        control_layers = self.raw_metadata.get("controlLayers", [])
        return [
            ControlLayer(
                model_name=layer.get("controlAdapter", {}).get("name", "Unknown Model"),
                image_name=layer.get("objects", {}).get("image_name", ""),
                weight=layer.get("controlAdapter", {}).get("weight", 1.0),
            )
            for layer in control_layers
            if layer.get("isEnabled", False)
        ]

    def _get_control_layers_from_canvas_v2(self) -> List[ControlLayer]:
        """
        This is called to get the control layers when the metadata contains a canvas_v2_metadata field,
        and not the "controlLayers" tag.
        """
        control_layers = self.raw_metadata.get("canvas_v2_metadata", {}).get(
            "controlLayers", []
        )
        return [
            ControlLayer(
                model_name=layer.get("controlAdapter", {})
                .get("model", {})
                .get("name", "Unknown Model"),
                image_name=", ".join(
                    [
                        x.get("image", {}).get("image_name", "")
                        for x in layer.get("objects", [])
                    ]
                ),
                weight=layer.get("controlAdapter", {}).get("weight", 1.0),
            )
            for layer in control_layers
            if layer.get("isEnabled", False)
        ]
