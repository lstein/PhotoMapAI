from typing import Any, List, Literal, Optional

from pydantic import BaseModel, ConfigDict


class Prompt(BaseModel):
    prompt: str
    weight: float


class Image(BaseModel):
    cfg_scale: float
    height: int
    hires_fix: Optional[bool] = None
    perlin: Optional[int | float] = None
    postprocessing: Optional[Any]
    prompt: str | List[Prompt]
    sampler: str
    seamless: Optional[bool] = None
    seed: int
    steps: int
    threshold: Optional[int | float] = None
    type: str
    variations: Optional[List[Any]] = None
    width: int


class GenerationMetadata2(BaseModel):
    model_config = ConfigDict(extra="forbid")
    metadata_version: Literal[2]
    app_id: str
    app_version: str
    image: Optional[Image] = None
    images: Optional[List[Image]] = None
    model: str
    model_hash: str
    model_weights: Optional[str] = None
