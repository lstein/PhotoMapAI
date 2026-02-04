from typing import Literal, Optional

from pydantic import BaseModel, Field


# Pydantic classes for version 3
class Model(BaseModel):
    base_model: Optional[str] = Field(alias="base", default=None)
    model_name: str = Field(alias="name")
    model_type: Optional[str] = Field(alias="type", default=None)

    class Config:
        populate_by_name = True


class Vae(BaseModel):
    base_model: str = Field(alias="base")
    model_name: str = Field(alias="name")

    class Config:
        populate_by_name = True


# All fields are optional because of various glitches and exceptions in v3 metadata
class GenerationMetadata3(BaseModel):
    metadata_version: Literal[3]
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
    vae: Optional[Vae] = None
    cfg_rescale_multiplier: Optional[float] = None
    cfg_scale: Optional[float] = None
    esrgan_model: Optional[str] = None
