from typing import Literal

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
    tool: str | None = None
    stroke_width: int | None = Field(default=None, alias="strokeWidth")
    x: int | None = None
    y: int | None = None
    width: int | None = None
    height: int | None = None
    image_name: str | None = Field(default=None, alias="imageName")
    points: list[float] | None = None
    clip: Clip | None = None


class PostProcessing(BaseModel):
    type: str
    orig_path: list[str] | None = None
    orig_hash: str | None = None
    scale: float | None = None
    strength: float | None = None


# Most fields are optional because of various glitches and exceptions in v3 metadata
class GenerationMetadata3(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    metadata_version: Literal[3]
    app_version: str | None = Field(default="3.X.X", alias="imported_app_version")
    generation_mode: str | None = None
    positive_prompt: str | None = None
    positive_style_prompt: str | None = None
    negative_prompt: str | None = None
    negative_style_prompt: str | None = None
    height: int | None = None
    width: int | None = None
    rand_device: str | None = None
    scheduler: str | None = None
    seed: int | None = None
    steps: int | None = None
    strength: float | None = None
    init_image: str | None = None
    post_processing: list[PostProcessing] | None = None
    model: Model | None = None
    vae: Model | None = None
    ip_adapters: list[IPAdapter] | None = Field(default=None, alias="ipAdapters")
    t2iAdapters: list[T2IAdapter] | None = None
    loras: list[Lora] | None = None
    controlnets: list[ControlAdapter] | None = None
    cfg_rescale_multiplier: float | None = None
    cfg_scale: float | None = None
    esrgan_model: str | None = None
    clip_skip: int | None = None
    seamless_x: bool | None = None
    seamless_y: bool | None = None
    # These fields appear in some app_version 3 images
    refiner_model: Model | None = None
    refiner_cfg_scale: float | None = None
    refiner_steps: int | None = None
    refiner_scheduler: str | None = None
    refiner_positive_aesthetic_score: float | None = Field(
        default=None, alias="refiner_positive_aesthetic_store"
    )
    refiner_negative_aesthetic_score: float | None = Field(
        default=None, alias="refiner_negative_aesthetic_store"
    )
    refiner_start: float | None = None
    # A few examples of these
    hrf_enabled: bool | None = None
    hrf_method: str | None = None
    hrf_strength: float | None = None
    hrf_width: int | None = None
    hrf_height: int | None = None
    # One example of this found!
    canvas_objects: list[CanvasObject] | None = Field(
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
