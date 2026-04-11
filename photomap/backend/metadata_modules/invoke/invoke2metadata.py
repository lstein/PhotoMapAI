from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, model_serializer, model_validator

from photomap.backend.metadata_modules.invoke.common_metadata_elements import Model


class Prompt(BaseModel):
    prompt: str
    weight: float


class ImageVariation(BaseModel):
    seed: int
    weight: float


class Image(BaseModel):
    cfg_scale: float
    height: int
    hires_fix: bool | None = None
    perlin: int | float | None = None
    postprocessing: Any | None
    prompt: str | list[Prompt]
    sampler: str
    seamless: bool | None = None
    seed: int
    steps: int
    threshold: int | float | None = None
    type: str
    variations: list[ImageVariation] | None = None
    width: int


class ModelListElement(BaseModel):
    model: Model
    status: str
    description: str


class GenerationMetadata2(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    metadata_version: Literal[2]
    app_id: str
    model_id: str | None = None
    app_version: str
    image: Image | None = None
    images: list[Image] | None = None
    model: str
    model_hash: str
    model_weights: str | None = None
    # This appears in a few old images, but is not well structured.
    # We structure it a bit in the model validator.
    model_list: list[ModelListElement] | None = None

    @model_validator(mode="before")
    @classmethod
    def validate_model_id(cls, data: dict[str, Any]) -> dict[str, Any]:
        """Munge the model_list into a more compatible structure"""
        if "model_list" in data and isinstance(data["model_list"], dict):
            model_list = []
            for model_entry_key, model_entry_value in data["model_list"].items():
                new_model_entry = {}
                new_model_entry["model"] = Model(model_name=model_entry_key)
                if isinstance(model_entry_value, dict):
                    new_model_entry["status"] = model_entry_value.get("status", "")
                    new_model_entry["description"] = model_entry_value.get(
                        "description", ""
                    )
                model_list.append(new_model_entry)
            data["model_list"] = model_list
        return data

    @model_serializer(mode="wrap")
    def serialize_model(self, serializer, info):
        """Exclude None values when serializing."""
        data = serializer(self)
        return {k: v for k, v in data.items() if v is not None}
