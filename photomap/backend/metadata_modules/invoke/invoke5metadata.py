from typing import Any, List, Literal, Optional

from pydantic import BaseModel, Field


# Pydantic classes for version 5
class Model(BaseModel):
    base: str
    hash: str
    key: str
    name: str
    type: str


class ClipEmbedModel(BaseModel):
    base: str
    hash: str
    key: str
    name: str
    type: str


class T5Encoder(BaseModel):
    base: str
    hash: str
    key: str
    name: str
    type: str


class Vae(BaseModel):
    base: str
    hash: str
    key: str
    name: str
    type: str


class Lora(BaseModel):
    model: Model
    weight: float


class Image(BaseModel):
    image_name: str
    width: Optional[int]
    height: Optional[int]


class RefImageConfig(BaseModel):
    type: str
    image: Image
    model: Optional[Model] = None
    beginEndStepPct: Optional[List[float]] = None
    method: Optional[str] = None
    clipVisionModel: Optional[str] = None
    weight: Optional[float] = None
    image_influence: Optional[str] = Field(default=None, alias="imageInfluence")


class RefImage(BaseModel):
    id: str
    isEnabled: bool
    config: RefImageConfig


# Empirically, pretty much all fields are optional in v5!
class GenerationMetadata5(BaseModel):
    metadata_version: Literal[5]
    app_version: str
    model: Optional[Model] = None
    generation_mode: Optional[str] = None
    height: Optional[int] = None
    width: Optional[int] = None
    positive_prompt: Optional[str] = None
    negative_prompt: Optional[str] = None
    scheduler: Optional[str] = None
    seed: Optional[int] = None
    steps: Optional[int] = None
    guidance: Optional[int | float] = None
    ref_images: Optional[List[RefImage]] = None
    loras: Optional[List[Lora]] = None
    t5_encoder: Optional[T5Encoder] = None
    vae: Optional[Vae] = None
    clip_embed_model: Optional[ClipEmbedModel] = None
    dype_preset: Optional[str] = None
