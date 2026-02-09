from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_serializer, model_validator

from photomap.backend.metadata_modules.invoke.canvas2metadata import Clip
from photomap.backend.metadata_modules.invoke.common_metadata_elements import (
    ControlAdapter,
    IPAdapter,
    Lora,
    Model,
    tag_reference_images,
)


class T2IAdapter(IPAdapter):
    pass


class CanvasObject(BaseModel):
    kind: str
    layer: str
    tool: Optional[str] = None
    stroke_width: Optional[int] = Field(default=None, alias="strokeWidth")
    x: Optional[int] = None
    y: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None
    image_name: Optional[str] = Field(default=None, alias="imageName")
    points: Optional[List[float]] = None
    clip: Optional[Clip] = None


class PostProcessing(BaseModel):
    type: str
    orig_path: Optional[List[str]] = None
    orig_hash: Optional[str] = None
    scale: Optional[float] = None
    strength: Optional[float] = None


# Most fields are optional because of various glitches and exceptions in v3 metadata
class GenerationMetadata3(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    metadata_version: Literal[3]
    app_version: Optional[str] = Field(default="3.X.X", alias="imported_app_version")
    generation_mode: Optional[str] = None
    positive_prompt: Optional[str] = None
    positive_style_prompt: Optional[str] = None
    negative_prompt: Optional[str] = None
    negative_style_prompt: Optional[str] = None
    height: Optional[int] = None
    width: Optional[int] = None
    rand_device: Optional[str] = None
    scheduler: Optional[str] = None
    seed: Optional[int] = None
    steps: Optional[int] = None
    strength: Optional[float] = None
    init_image: Optional[str] = None
    post_processing: Optional[List[PostProcessing]] = None
    model: Optional[Model] = None
    vae: Optional[Model] = None
    ip_adapters: Optional[List[IPAdapter]] = Field(default=None, alias="ipAdapters")
    t2iAdapters: Optional[List[T2IAdapter]] = None
    loras: Optional[List[Lora]] = None
    controlnets: Optional[List[ControlAdapter]] = None
    cfg_rescale_multiplier: Optional[float] = None
    cfg_scale: Optional[float] = None
    esrgan_model: Optional[str] = None
    clip_skip: Optional[int] = None
    seamless_x: Optional[bool] = None
    seamless_y: Optional[bool] = None
    # These fields appear in some app_version 3 images
    refiner_model: Optional[Model] = None
    refiner_cfg_scale: Optional[float] = None
    refiner_steps: Optional[int] = None
    refiner_scheduler: Optional[str] = None
    refiner_positive_aesthetic_score: Optional[float] = Field(
        default=None, alias="refiner_positive_aesthetic_store"
    )
    refiner_negative_aesthetic_score: Optional[float] = Field(
        default=None, alias="refiner_negative_aesthetic_store"
    )
    refiner_start: Optional[float] = None
    # A few examples of these
    hrf_enabled: Optional[bool] = None
    hrf_method: Optional[str] = None
    hrf_strength: Optional[float] = None
    hrf_width: Optional[int] = None
    hrf_height: Optional[int] = None
    # One example of this found!
    canvas_objects: Optional[List[CanvasObject]] = Field(
        default=None, alias="_canvas_objects"
    )

    @model_validator(mode="before")
    @classmethod
    def fixup_orphan_images(cls, data: dict) -> dict:
        """
        Fix up any orphaned reference images by sticking them into a postprocessing model.
        """
        if (
            "image" in data
            and isinstance(data["image"], dict)
            and "postprocessing" in data["image"]
        ):
            post_processing_list = []
            for post_processing_entry in data["image"]["postprocessing"]:
                post_processing_list.append(
                    PostProcessing(
                        orig_path=post_processing_entry.get("orig_path"),
                        orig_hash=post_processing_entry.get("orig_hash"),
                        type=post_processing_entry.get("type"),
                        strength=post_processing_entry.get("strength"),
                        scale=post_processing_entry.get("scale"),
                    )
                )
            data.pop("image")
            data["post_processing"] = post_processing_list
        return data

    @model_validator(mode="before")
    @classmethod
    def tag_reference_images(cls, data):
        """Tag reference images with a discriminator for proper parsing."""
        if "ipAdapters" in data and isinstance(data["ipAdapters"], list):
            for ref_image in data["ipAdapters"]:
                if image := ref_image.get("image"):
                    tag_reference_images(image)
        return data

    @model_validator(mode="before")
    @classmethod
    def fixup_aesthetic_score(cls, json_data: dict) -> dict:
        """Replace the refiner_aesthetic_store and refiner_aesthetic_score fields with refiner_positive_aesthetic_score."""
        for key in ["refiner_positive_aesthetic_store", "refiner_aesthetic_store"]:
            if key in json_data:
                json_data["refiner_positive_aesthetic_score"] = json_data.pop(key)
        return json_data

    @model_serializer(mode="wrap")
    def serialize_model(self, serializer, info):
        """Exclude None values when serializing."""
        data = serializer(self)
        return {k: v for k, v in data.items() if v is not None}
