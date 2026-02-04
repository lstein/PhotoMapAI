from typing import Annotated, Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, Field


class Clip(BaseModel):
    height: float
    width: float
    x: float
    y: float


class Color(BaseModel):
    b: int
    g: int
    r: int


class Fill(BaseModel):
    color: Color
    style: str


class Model(BaseModel):
    base: str
    hash: str
    key: str
    name: str
    type: str


class ImageData(BaseModel):
    image_type: Literal["dataURL"] = Field(default="dataURL", alias="type")
    data_url: str = Field(alias="dataURL")
    height: int
    width: int

    class Config:
        populate_by_name = True


class ImageFile(BaseModel):
    image_type: Literal["file"] = Field(default="file", alias="type")
    image_name: str
    height: int
    width: int

    class Config:
        populate_by_name = True


ImageUnion = Annotated[
    Union[ImageFile, ImageData],
    Field(discriminator="image_type"),
]


class Object(BaseModel):
    id: str
    image: Optional[ImageUnion] = None
    type: str


class Position(BaseModel):
    x: int | float
    y: int | float


class Inpaintmask(BaseModel):
    fill: Fill
    id: str
    is_enabled: bool = Field(alias="isEnabled")
    is_locked: bool = Field(alias="isLocked")
    name: Optional[Any]
    objects: List[Object]
    opacity: int
    position: Position
    type: str

    class Config:
        populate_by_name = True


class Rasterlayer(BaseModel):
    id: str
    is_enabled: bool = Field(alias="isEnabled")
    is_locked: bool = Field(alias="isLocked")
    name: Optional[Any]
    objects: List[Object]
    opacity: int
    position: Position
    type: str

    class Config:
        populate_by_name = True


class Ipadapter(BaseModel):
    begin_end_step_pct: Optional[List[int | float]] = Field(
        None, alias="beginEndStepPct"
    )
    clip_vision_model: Optional[str] = Field(None, alias="clipVisionModel")
    image: ImageUnion
    model: Model
    type: str
    method: Optional[str] = None
    weight: Optional[float] = None

    class Config:
        populate_by_name = True


class ReferenceImage(BaseModel):
    id: str
    ip_adapter: Ipadapter = Field(alias="ipAdapter")
    is_enabled: Optional[bool] = Field(None, alias="isEnabled")
    is_locked: Optional[bool] = Field(None, alias="isLocked")
    name: Optional[Any] = None
    type: Optional[str] = None

    class Config:
        populate_by_name = True


class Controladapter(BaseModel):
    begin_end_step_pct: List[int | float] = Field(alias="beginEndStepPct")
    control_mode: Optional[str] = Field(None, alias="controlMode")
    model: Model
    type: str
    weight: float

    class Config:
        populate_by_name = True


class Controllayer(BaseModel):
    control_adapter: Controladapter = Field(alias="controlAdapter")
    id: str
    is_enabled: bool = Field(alias="isEnabled")
    is_locked: bool = Field(alias="isLocked")
    name: Optional[Any]
    objects: List[Object]
    opacity: int
    position: Position
    type: str
    with_transparency_effect: bool = Field(alias="withTransparencyEffect")

    class Config:
        populate_by_name = True


class RegionalGuidance(BaseModel):
    auto_negative: bool = Field(alias="autoNegative")
    fill: Fill
    id: str
    is_enabled: bool = Field(alias="isEnabled")
    is_locked: bool = Field(alias="isLocked")
    name: Optional[Any]
    negative_prompt: Optional[Any] = Field(None, alias="negativePrompt")
    objects: List[Object]
    opacity: float
    position: Position
    positive_prompt: Optional[Any] = Field(None, alias="positivePrompt")
    reference_images: List[ReferenceImage] = Field(alias="referenceImages")
    type: str

    class Config:
        populate_by_name = True


class CanvasV2Metadata(BaseModel):
    raster_layers: Optional[List[Rasterlayer]] = Field(None, alias="rasterLayers")
    control_layers: Optional[List[Controllayer]] = Field(None, alias="controlLayers")
    inpaint_masks: Optional[List[Inpaintmask]] = Field(None, alias="inpaintMasks")
    reference_images: Optional[List[ReferenceImage]] = Field(
        None, alias="referenceImages"
    )
    regional_guidance: Optional[List[RegionalGuidance]] = Field(
        None, alias="regionalGuidance"
    )

    class Config:
        populate_by_name = True


class GenerationMetadataCanvas(BaseModel):
    metadata_version: Literal["canvas"]
    canvas_v2_metadata: CanvasV2Metadata
    model: Optional[Model] = None
    negative_prompt: Optional[str] = None
    positive_prompt: Optional[str] = None
    seed: Optional[int] = None
