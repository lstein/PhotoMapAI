"""
Wrapper for GenerationMetadata
"""

from typing import Annotated, Any, List, Optional, Union

from pydantic import Field, TypeAdapter

from .invoke.canvas2metadata import GenerationMetadataCanvas
from .invoke.invoke2metadata import GenerationMetadata2
from .invoke.invoke3metadata import GenerationMetadata3
from .invoke.invoke5metadata import (
    GenerationMetadata5,
    Image,
    Model,
    RefImage,
    RefImageConfig,
)

GenerationMetadata = Annotated[
    Union[
        GenerationMetadata2,
        GenerationMetadata3,
        GenerationMetadata5,
        GenerationMetadataCanvas,
    ],
    Field(discriminator="metadata_version"),
]


class GenerationMetadataAdapter:
    def __init__(self):
        self.adapter = TypeAdapter(GenerationMetadata)
        self.metadata = None

    def parse(self, json_data: dict[str, Any]) -> GenerationMetadata:
        """
        Parse JSON data into a GenerationMetadata object.

        :param json_data: Dictionary containing metadata
        :type json_data: dict[str, Any]
        :return: Parsed generation metadata
        :rtype: GenerationMetadata
        """
        if "metadata_version" not in json_data:
            if "canvas_v2_metadata" in json_data:
                json_data = {"metadata_version": "canvas", **json_data}
            elif "app_version" in json_data:
                if any(
                    json_data["app_version"].startswith(x) for x in ["v1.", "2.", "v2."]
                ):
                    json_data = {"metadata_version": 2, **json_data}
                elif json_data["app_version"].startswith("3."):
                    if "model" in json_data and isinstance(json_data["model"], str):
                        json_data = {"metadata_version": 2, **json_data}
                    else:
                        json_data = {"metadata_version": 3, **json_data}
                else:
                    json_data = {"metadata_version": 5, **json_data}
            elif "model_weights" in json_data:
                # v2 metadata has model_weights field
                json_data = {"metadata_version": 2, **json_data}
            else:
                json_data = {"metadata_version": 3, **json_data}

        # Normalize ref_images
        if "ref_images" in json_data and json_data["ref_images"]:
            json_data["ref_images"] = self._normalize_ref_images(
                json_data["ref_images"]
            )

        # Preprocess canvas metadata to add image type discriminators
        json_data = self._preprocess_canvas_metadata(json_data)

        self.metadata = self.adapter.validate_python(json_data)
        return self.metadata

    @property
    def positive_prompt(self) -> Optional[str]:
        if self.metadata is None:
            return None
        if hasattr(self.metadata, "positive_prompt"):
            return getattr(self.metadata, "positive_prompt")
        if (
            hasattr(self.metadata, "image")
            and self.metadata.image
            and hasattr(self.metadata.image, "prompt")
        ):
            return getattr(self.metadata.image, "prompt")
        return None

    @property
    def negative_prompt(self) -> Optional[str]:
        if self.metadata is None:
            return None
        if hasattr(self.metadata, "negative_prompt"):
            return self.metadata.negative_prompt
        return None

    @property
    def model_name(self) -> Optional[str]:
        if self.metadata is None:
            return None
        if hasattr(self.metadata.model, "name"):
            return self.metadata.model.name
        else:
            return self.metadata.model

    @property
    def seed(self) -> Optional[int]:
        if self.metadata is None:
            return None
        if hasattr(self.metadata, "seed"):
            return self.metadata.seed
        if (
            hasattr(self.metadata, "image")
            and self.metadata.image
            and hasattr(self.metadata.image, "seed")
        ):
            return self.metadata.image.seed
        return None

    @property
    def steps(self) -> Optional[int]:
        if self.metadata is None:
            return None
        if hasattr(self.metadata, "steps"):
            return self.metadata.steps
        if (
            hasattr(self.metadata, "image")
            and self.metadata.image
            and hasattr(self.metadata.image, "steps")
        ):
            return self.metadata.image.steps
        return None

    @property
    def height(self) -> Optional[int]:
        if self.metadata is None:
            return None
        if hasattr(self.metadata, "height"):
            return self.metadata.height
        if (
            hasattr(self.metadata, "image")
            and self.metadata.image
            and hasattr(self.metadata.image, "height")
        ):
            return self.metadata.image.height
        return None

    @property
    def width(self) -> Optional[int]:
        if self.metadata is None:
            return None
        if hasattr(self.metadata, "width"):
            return self.metadata.width
        if (
            hasattr(self.metadata, "image")
            and self.metadata.image
            and hasattr(self.metadata.image, "width")
        ):
            return self.metadata.image.width
        return None

    @property
    def ref_images(self) -> Optional[List[RefImage]]:
        if self.metadata is None:
            return None
        if hasattr(self.metadata, "ref_images"):
            return self.metadata.ref_images
        if (
            hasattr(self.metadata, "canvas_v2_metadata")
            and self.metadata.canvas_v2_metadata
        ):
            if self.metadata.canvas_v2_metadata.reference_images:
                return [
                    RefImage(
                        isEnabled=ri.is_enabled,
                        id=ri.id,
                        config=RefImageConfig(
                            type=ri.ip_adapter.type,
                            image=Image(
                                image_name=ri.ip_adapter.image.image_name,
                                width=(
                                    ri.ip_adapter.image.width
                                    if hasattr(ri.ip_adapter.image, "width")
                                    else None
                                ),
                                height=(
                                    ri.ip_adapter.image.height
                                    if hasattr(ri.ip_adapter.image, "height")
                                    else None
                                ),
                            ),
                            model=(
                                Model(
                                    base=ri.ip_adapter.model.base,
                                    hash=ri.ip_adapter.model.hash,
                                    key=ri.ip_adapter.model.key,
                                    name=ri.ip_adapter.model.name,
                                    type=ri.ip_adapter.model.type,
                                )
                            ),
                            weight=(
                                ri.ip_adapter.weight
                                if hasattr(ri, "ip_adapter")
                                and ri.ip_adapter
                                and hasattr(ri.ip_adapter, "weight")
                                else None
                            ),
                            image_influence=(
                                ri.ip_adapter.image_influence
                                if hasattr(ri, "ip_adapter")
                                and ri.ip_adapter
                                and hasattr(ri.ip_adapter, "image_influence")
                                else None
                            ),
                            method=(
                                ri.ip_adapter.method
                                if hasattr(ri, "ip_adapter")
                                and ri.ip_adapter
                                and hasattr(ri.ip_adapter, "method")
                                else None
                            ),
                        ),
                    )
                    for ri in self.metadata.canvas_v2_metadata.reference_images
                ]
        return None

    def _preprocess_canvas_metadata(self, json_data: dict[str, Any]) -> dict[str, Any]:
        """Preprocess canvas metadata to add type discriminators to image objects."""
        if "canvas_v2_metadata" not in json_data:
            return json_data

        canvas_metadata = json_data["canvas_v2_metadata"]

        def add_image_type_discriminator(image: dict[str, Any]) -> None:
            """Add image_type discriminator to an image object based on its fields."""
            if "dataURL" in image:
                image["image_type"] = "dataURL"
            elif "image_name" in image:
                image["image_type"] = "file"

        def process_image_in_dict(obj: dict[str, Any], key: str = "image") -> None:
            """Add type discriminator to an image object if it exists."""
            if key in obj and obj[key]:
                add_image_type_discriminator(obj[key])

        def process_objects(objects: list[dict[str, Any]]) -> None:
            """Process a list of objects that may contain images."""
            for obj in objects:
                process_image_in_dict(obj)

        def process_reference_images(ref_images: list[dict[str, Any]]) -> None:
            """Process reference images with ipAdapter."""
            for ref_image in ref_images:
                if "ipAdapter" in ref_image and ref_image["ipAdapter"]:
                    process_image_in_dict(ref_image["ipAdapter"])

        # Process layers with objects (rasterLayers, inpaintMasks, controlLayers)
        for layer_key in ["rasterLayers", "inpaintMasks", "controlLayers"]:
            if layer_key in canvas_metadata and canvas_metadata[layer_key]:
                for layer in canvas_metadata[layer_key]:
                    if "objects" in layer and layer["objects"]:
                        process_objects(layer["objects"])

        # Process top-level referenceImages
        if "referenceImages" in canvas_metadata and canvas_metadata["referenceImages"]:
            process_reference_images(canvas_metadata["referenceImages"])

        # Process regionalGuidance with objects and referenceImages
        if (
            "regionalGuidance" in canvas_metadata
            and canvas_metadata["regionalGuidance"]
        ):
            for region in canvas_metadata["regionalGuidance"]:
                if "objects" in region and region["objects"]:
                    process_objects(region["objects"])
                if "referenceImages" in region and region["referenceImages"]:
                    process_reference_images(region["referenceImages"])

        return json_data

    def _normalize_ref_images(self, ref_images: Any) -> list[dict[str, Any]]:
        """
        Normalize ref_images structure.

        Handles both flat lists and nested lists (list of lists).
        Flattens nested image structure from config.image.original.image to config.image.

        :param ref_images: Raw ref_images data (may be list or list of lists)
        :type ref_images: Any
        :return: Normalized flat list of reference images
        :rtype: list[dict[str, Any]]
        """
        if not isinstance(ref_images, list) or len(ref_images) == 0:
            return ref_images

        # Flatten if it's a list of lists
        if isinstance(ref_images[0], list):
            ref_images = ref_images[0]

        # Normalize nested image structure in ref_images config
        for ref_image in ref_images:
            if (
                "config" in ref_image
                and "image" in ref_image["config"]
                and isinstance(ref_image["config"]["image"], dict)
            ):
                image_obj = ref_image["config"]["image"]
                # If image has ["original"]["image"] nesting, flatten it
                if "original" in image_obj and isinstance(image_obj["original"], dict):
                    if "image" in image_obj["original"]:
                        ref_image["config"]["image"] = image_obj["original"]["image"]

        return ref_images
