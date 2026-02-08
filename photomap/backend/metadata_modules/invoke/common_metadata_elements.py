import sys
from typing import Annotated, Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Color(BaseModel):
    b: int
    g: int
    r: int


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    name: str = Field(alias="model_name")
    base: str = Field(default="unknown", alias="base_model")
    hash: Optional[str] = None
    key: Optional[str] = None
    type: str = Field(default="main", alias="model_type")


class T5Encoder(Model):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


class ClipEmbedModel(Model):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


class ControlAdapter(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    begin_end_step_pct: List[int | float] = Field(alias="beginEndStepPct")
    control_mode: Optional[str] = Field(None, alias="controlMode")
    model: Model
    type: str
    weight: float

    @model_validator(mode="before")
    @classmethod
    def fixup_step_percentages(cls, json_data: Dict[str, Any]) -> Dict[str, Any]:
        """Convert begin_step_percent and end_step_percent to beginEndStepPct if they exist, and ensure the values are in a list."""
        return fixup_step_percentages(json_data)


class ImageData(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["dataURL"] = Field(default="dataURL", alias="image_type")
    data_url: str = Field(alias="dataURL")
    height: Optional[int] = None
    width: Optional[int] = None


class ImageFile(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["file"] = Field(default="file", alias="image_type")
    name: str = Field(alias="image_name")
    height: Optional[int] = None
    width: Optional[int] = None


Image = Annotated[
    Union[ImageFile, ImageData],
    Field(discriminator="type"),
]


class Lora(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    model: Model = Field(alias="lora")
    weight: float


class IPAdapter(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    begin_end_step_pct: Optional[List[int | float]] = Field(
        None, alias="beginEndStepPct"
    )
    model: Model
    image: Image
    type: Optional[str] = None
    method: Optional[str] = None
    weight: Optional[float] = None
    image_influence: Optional[str] = Field(None, alias="imageInfluence")

    @model_validator(mode="before")
    @classmethod
    def fixup_step_percentages(cls, json_data: Dict[str, Any]) -> Dict[str, Any]:
        """Convert begin_step_percent and end_step_percent to beginEndStepPct if they exist, and ensure the values are in a list."""
        return fixup_step_percentages(json_data)

    @model_validator(mode="before")
    @classmethod
    def tag_reference_images(cls, data: Dict[str, Any]) -> Dict[str, Any]:
        """Tag reference images with a discriminator for proper parsing."""
        if "image" in data and isinstance(data["image"], dict):
            tag_reference_images(data["image"])
        return data

    @model_validator(mode="before")
    @classmethod
    def consolidate_model_aliases(cls, data):
        """Consolidate model aliases to ensure the model field is populated correctly."""
        for key in ["clip_vision_model", "ip_adapter_model", "t2i_adapter_model"]:
            if "model" not in data and key in data:
                data["model"] = data[key]
                break
        return data


class ReferenceImage(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    id: str
    ip_adapter: IPAdapter = Field(alias="ipAdapter")
    is_enabled: Optional[bool] = Field(None, alias="isEnabled")
    is_locked: Optional[bool] = Field(None, alias="isLocked")
    name: Optional[Any] = None
    type: Optional[str] = None


class Fill(BaseModel):
    color: Color
    style: str


class Position(BaseModel):
    x: int | float
    y: int | float


class Object(BaseModel):
    id: str
    image: Optional[Image] = None
    type: str


class RegionalGuidance(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    auto_negative: bool = Field(alias="autoNegative")
    fill: Fill
    id: str
    is_enabled: bool = Field(alias="isEnabled")
    is_locked: bool = Field(alias="isLocked")
    name: Optional[Any]
    positive_prompt: Optional[str] = Field(None, alias="positivePrompt")
    negative_prompt: Optional[str] = Field(None, alias="negativePrompt")
    objects: List[Object]
    opacity: float
    position: Position
    reference_images: List[ReferenceImage] = Field(alias="referenceImages")
    type: str


def tag_reference_images(image: Dict[str, Any]) -> None:
    """Mutates the input image dict to add an "image_type" field based on whether it has a "dataURL" or "image_name" field."""
    if "dataURL" in image:
        image["type"] = "dataURL"
    elif "image_name" in image:
        image["type"] = "file"
    elif "name" in image:
        image["type"] = "file"


def fixup_step_percentages(json_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Helper function to convert begin_step_percent and end_step_percent to beginEndStepPct if they exist,
    and ensure the values are in a list.
    """
    for key in ["begin_step_percent", "end_step_percent"]:
        if key in json_data:
            value = json_data.pop(key)
            if isinstance(value, (int, float)):
                json_data.setdefault("beginEndStepPct", []).append(value)
            elif isinstance(value, list):
                json_data.setdefault("beginEndStepPct", []).extend(value)
    return json_data
