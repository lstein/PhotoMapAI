from typing import Annotated, Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, model_serializer, model_validator

from photomap.backend.metadata_modules.invoke.common_metadata_elements import (
    ClipEmbedModel,
    ControlAdapter,
    Fill,
    Lora,
    Model,
    Object,
    Position,
    ReferenceImage,
    RegionalGuidance,
    T5Encoder,
    tag_reference_images,
)


class Clip(BaseModel):
    height: float
    width: float
    x: float
    y: float


class Inpaintmask(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    fill: Fill
    id: str
    is_enabled: bool = Field(alias="isEnabled")
    is_locked: bool = Field(alias="isLocked")
    name: Optional[Any]
    objects: List[Object]
    opacity: int
    position: Position
    type: str


class Rasterlayer(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    id: str
    is_enabled: bool = Field(alias="isEnabled")
    is_locked: bool = Field(alias="isLocked")
    name: Optional[Any]
    objects: List[Object]
    opacity: int
    position: Position
    type: str


class ControlLayer(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    control_adapter: ControlAdapter = Field(alias="controlAdapter")
    id: str
    is_enabled: bool = Field(alias="isEnabled")
    is_locked: bool = Field(alias="isLocked")
    name: Optional[Any]
    objects: List[Object]
    opacity: int
    position: Position
    type: str
    with_transparency_effect: bool = Field(alias="withTransparencyEffect")


class CanvasV2Metadata(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    raster_layers: Optional[List[Rasterlayer]] = Field(None, alias="rasterLayers")
    control_layers: Optional[List[ControlLayer]] = Field(None, alias="controlLayers")
    inpaint_masks: Optional[List[Inpaintmask]] = Field(None, alias="inpaintMasks")
    reference_images: Optional[List[ReferenceImage]] = Field(
        None, alias="referenceImages"
    )
    regional_guidance: Optional[List[RegionalGuidance]] = Field(
        None, alias="regionalGuidance"
    )

    @model_validator(mode="before")
    @classmethod
    def _preprocess_canvas_metadata(
        cls, canvas_metadata: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Preprocess canvas metadata to add type discriminators to image objects."""

        def process_image_in_dict(obj: dict[str, Any], key: str = "image") -> None:
            """Add type discriminator to an image object if it exists."""
            if key in obj and obj[key]:
                tag_reference_images(obj[key])

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

        return canvas_metadata

    @model_serializer(mode="wrap")
    def serialize_model(self, serializer, info):
        """Exclude None values when serializing."""
        data = serializer(self)
        return {k: v for k, v in data.items() if v is not None}
