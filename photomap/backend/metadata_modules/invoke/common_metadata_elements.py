from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_serializer, model_validator


class Color(BaseModel):
    b: int
    g: int
    r: int


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    name: str = Field(alias="model_name")
    base: str | None = Field(default=None, alias="base_model")
    hash: str | None = None
    key: str | None = None
    type: str = Field(default="main", alias="model_type")

    @model_serializer(mode="wrap")
    def serialize_model(self, serializer, info):
        """Exclude None values when serializing."""
        data = serializer(self)
        return {k: v for k, v in data.items() if v is not None}


class T5Encoder(Model):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


class ClipEmbedModel(Model):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


class ImageData(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["dataURL"] = Field(default="dataURL", alias="image_type")
    data_url: str = Field(alias="dataURL")
    height: int | None = None
    width: int | None = None


class ImageFile(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["file"] = Field(default="file", alias="image_type")
    name: str = Field(alias="image_name")
    height: int | None = None
    width: int | None = None


Image = Annotated[
    ImageFile | ImageData,
    Field(discriminator="type"),
]


class ControlAdapter(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    image: Image
    begin_end_step_pct: list[int | float] = Field(alias="beginEndStepPct")
    control_mode: str | None = Field(None, alias="controlMode")
    model: Model = Field(alias="control_model")
    type: str | None = Field(default=None)
    weight: float = Field(alias="control_weight")

    @model_validator(mode="before")
    @classmethod
    def fixup_step_percentages(cls, json_data: dict[str, Any]) -> dict[str, Any]:
        """Convert begin_step_percent and end_step_percent to beginEndStepPct if they exist, and ensure the values are in a list."""
        return fixup_step_percentages(json_data)

    @model_validator(mode="before")
    @classmethod
    def tag_reference_images(cls, data: dict[str, Any]) -> dict[str, Any]:
        """Tag reference images with a discriminator for proper parsing."""
        if "image" in data and isinstance(data["image"], dict):
            tag_reference_images(data["image"])
        return data


class Lora(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    model: Model = Field(alias="lora")
    weight: float


class IPAdapter(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    begin_end_step_pct: list[int | float] | None = Field(
        None, alias="beginEndStepPct"
    )
    model: Model
    image: Image
    type: str | None = None
    method: str | None = None
    weight: float | None = None
    image_influence: str | None = Field(None, alias="imageInfluence")

    @model_validator(mode="before")
    @classmethod
    def fixup_step_percentages(cls, json_data: dict[str, Any]) -> dict[str, Any]:
        """Convert begin_step_percent and end_step_percent to beginEndStepPct if they exist, and ensure the values are in a list."""
        return fixup_step_percentages(json_data)

    @model_validator(mode="before")
    @classmethod
    def tag_reference_images(cls, data: dict[str, Any]) -> dict[str, Any]:
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
    is_enabled: bool | None = Field(None, alias="isEnabled")
    is_locked: bool | None = Field(None, alias="isLocked")
    name: Any | None = None
    type: str | None = None


class Fill(BaseModel):
    color: Color
    style: str


class Position(BaseModel):
    x: int | float
    y: int | float


class Object(BaseModel):
    id: str
    image: Image | None = None
    type: str


class RegionalGuidance(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    auto_negative: bool = Field(alias="autoNegative")
    fill: Fill
    id: str
    is_enabled: bool = Field(alias="isEnabled")
    is_locked: bool = Field(alias="isLocked")
    name: Any | None
    positive_prompt: str | None = Field(None, alias="positivePrompt")
    negative_prompt: str | None = Field(None, alias="negativePrompt")
    objects: list[Object]
    opacity: float
    position: Position
    reference_images: list[ReferenceImage] = Field(alias="referenceImages")
    type: str


def tag_reference_images(image: dict[str, Any]) -> None:
    """Mutates the input image dict to add an "image_type" field based on whether it has a "dataURL" or "image_name" field."""
    if "dataURL" in image:
        image["type"] = "dataURL"
    elif "image_name" in image:
        image["type"] = "file"
    elif "name" in image:
        image["type"] = "file"


def fixup_step_percentages(json_data: dict[str, Any]) -> dict[str, Any]:
    """
    Helper function to convert begin_step_percent and end_step_percent to beginEndStepPct if they exist,
    and ensure the values are in a list.
    """
    for key in ["begin_step_percent", "end_step_percent"]:
        if key in json_data:
            value = json_data.pop(key)
            if isinstance(value, int | float):
                json_data.setdefault("beginEndStepPct", []).append(value)
            elif isinstance(value, list):
                json_data.setdefault("beginEndStepPct", []).extend(value)
    return json_data
