from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_serializer, model_validator

from photomap.backend.metadata_modules.invoke.common_metadata_elements import (
    ControlAdapter,
    IPAdapter,
    Lora,
    Model,
    tag_reference_images,
)


class T2IAdapter(IPAdapter):
    pass


# All fields are optional because of various glitches and exceptions in v3 metadata
class GenerationMetadata3(BaseModel):
    model_config = ConfigDict(extra="forbid")
    metadata_version: Literal[3]
    app_version: str = Field(default="3.X.X")
    generation_mode: Optional[str] = None
    model: Optional[Model] = None
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

    @model_validator(mode="before")
    def tag_reference_images(cls, data):
        """Tag reference images with a discriminator for proper parsing."""
        if "ipAdapters" in data and isinstance(data["ipAdapters"], list):
            for ref_image in data["ipAdapters"]:
                if image := ref_image.get("image"):
                    tag_reference_images(image)
        return data

    @model_serializer(mode="wrap")
    def serialize_model(self, serializer, info):
        """Exclude None values when serializing."""
        data = serializer(self)
        return {k: v for k, v in data.items() if v is not None}
