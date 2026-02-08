from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_serializer, model_validator

from photomap.backend.metadata_modules.invoke.canvas2metadata import CanvasV2Metadata
from photomap.backend.metadata_modules.invoke.common_metadata_elements import (
    ClipEmbedModel,
    Image,
    IPAdapter,
    Lora,
    Model,
    RegionalGuidance,
    T5Encoder,
    fixup_step_percentages,
    tag_reference_images,
)


class ControlLayer(BaseModel):
    id: str
    type: str
    is_enabled: bool = Field(alias="isEnabled")
    is_selected: bool = Field(alias="isSelected")
    control_adapter: Optional[IPAdapter] = Field(default=None, alias="ipAdapter")


class ControlLayers(BaseModel):
    version: int | float
    layers: List[ControlLayer]


class ControlNet(BaseModel):
    image: Image
    model: Model = Field(alias="control_model")
    weight: Optional[float] = Field(alias="control_weight")
    begin_end_step_pct: Optional[List[int | float]] = Field(
        None, alias="beginEndStepPct"
    )
    control_mode: str
    resize_mode: str

    @model_validator(mode="before")
    @classmethod
    def fixup_step_percentages(cls, json_data: Dict[str, Any]) -> Dict[str, Any]:
        """Convert begin_step_percent and end_step_percent to beginEndStepPct if they exist, and ensure the values are in a list."""
        return fixup_step_percentages(json_data)


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

    @model_validator(mode="before")
    @classmethod
    def tag_reference_images(cls, data):
        """Tag reference images with a discriminator for proper parsing."""
        if "config" in data and isinstance(data["config"], dict):
            config = data["config"]
            if "image" in config and isinstance(config["image"], dict):
                tag_reference_images(config["image"])
        return data


# Empirically, pretty much all fields are optional in v5!
class GenerationMetadata5(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    metadata_version: Literal[5]
    app_version: Optional[str] = Field(default="5.X.X")
    model: Optional[Model | str] = Field(default=None, alias="Model")
    generation_mode: Optional[str] = None
    height: Optional[int] = None
    width: Optional[int] = None
    positive_prompt: Optional[str] = Field(default=None, alias="Positive Prompt")
    positive_style_prompt: Optional[str] = None
    negative_prompt: Optional[str] = None
    negative_style_prompt: Optional[str] = None
    scheduler: Optional[str] = None
    seed: Optional[int] = None
    steps: Optional[int] = Field(default=None, alias="Steps")
    guidance: Optional[int | float] = None
    ref_images: Optional[List[RefImage]] = None
    control_layers: Optional[ControlLayers] = Field(default=None)
    loras: Optional[List[Lora]] = None
    regions: Optional[List[RegionalGuidance]] = None
    t5_encoder: Optional[T5Encoder] = None
    qwen3_encoder: Optional[Model] = None
    qwen3_source: Optional[Model] = None
    vae: Optional[Model] = None
    clip_embed_model: Optional[ClipEmbedModel] = None
    dype_preset: Optional[str] = None
    rand_device: Optional[str] = None
    cfg_scale: Optional[float] = None
    cfg_rescale_multiplier: Optional[float] = None
    seamless_x: Optional[bool] = None
    seamless_y: Optional[bool] = None
    upscale_model: Optional[Model] = None
    upscale_initial_image: Optional[Image] = None
    upscale_scale: Optional[float] = None
    creativity: Optional[float] = None
    structure: Optional[float] = None
    tile_size: Optional[int] = None
    tile_overlap: Optional[int] = None
    clip_skip: Optional[int] = None
    canvas_v2_metadata: Optional[CanvasV2Metadata] = None
    # These fields appear in some ZiT images
    seed_variance_strength: Optional[float] = None
    seed_variance_enabled: Optional[bool] = Field(
        default=None, alias="z_image_seed_variance_enabled"
    )
    seed_variance_randomize_percentage: Optional[int] = Field(
        default=None, alias="z_image_seed_variance_randomize_percentage"
    )
    # These fields appear in some Flux.1 images
    dype_scale: Optional[float] = None
    dype_exponent: Optional[float] = None
    # These fields appear in some sdxl images
    strength: Optional[float] = None
    init_image: Optional[str] = None
    hrf_enabled: Optional[bool] = None
    hrf_method: Optional[str] = None
    hrf_strength: Optional[float] = None
    refiner_cfg_scale: Optional[float] = None
    refiner_steps: Optional[int] = None
    refiner_scheduler: Optional[str] = None
    refiner_positive_aesthetic_score: Optional[float] = None
    refiner_negative_aesthetic_score: Optional[float] = None
    refiner_start: Optional[float] = None

    @model_validator(mode="before")
    @classmethod
    def normalize_field_names(cls, data):
        """Normalize alternative field name variations before validation."""
        if isinstance(data, dict):
            # Map alternative names to canonical field names
            aliases = {
                "Seed variance strength": "seed_variance_strength",
                "z_image_seed_variance_strength": "seed_variance_strength",
                "z_image_seed_variance_randomize_percentage": "seed_variance_randomize_percentage",
                "z_image_seed_variance_randomize_percent": "seed_variance_randomize_percentage",
                "z_image_seed_variance_enabled": "seed_variance_enabled",
            }
            for alt_name, canonical_name in aliases.items():
                if alt_name in data and canonical_name not in data:
                    data[canonical_name] = data.pop(alt_name)

        return data

    @model_validator(mode="before")
    def tag_reference_images(cls, data):
        # NOTE: MOVE THIS TO THE PROPER IMAGE VALIDATOR
        """Tag reference images with a discriminator for proper parsing."""
        if "upscale_initial_image" in data and isinstance(
            data["upscale_initial_image"], dict
        ):
            tag_reference_images(data["upscale_initial_image"])
        if "controlnets" in data and isinstance(data["controlnets"], list):
            for controlnet in data["controlnets"]:
                if isinstance(controlnet, dict) and "image" in controlnet:
                    tag_reference_images(controlnet["image"])
        return data

    @model_validator(mode="before")
    def fixup_controlnets(cls, data: Dict[str, Any]) -> Dict[str, Any]:
        """ "
        Massage the legacy controlnet format into the new control_layers format
        """
        if "controlnets" in data and isinstance(data["controlnets"], list):
            layers = []
            for cn in data["controlnets"]:
                layer = {
                    "id": cn.get("id", ""),
                    "type": "controlnet",
                    "isEnabled": cn.get("isEnabled", True),
                    "isSelected": cn.get("isSelected", False),
                    "ipAdapter": {
                        "image": cn.get("image"),
                        "model": cn.get("control_model"),
                        "weight": cn.get("control_weight"),
                        "beginEndStepPct": cn.get("beginEndStepPct"),
                        "control_mode": cn.get("control_mode"),
                        "resize_mode": cn.get("resize_mode"),
                    },
                }
                layers.append(layer)
            data["control_layers"] = {"version": 1, "layers": layers}
            del data["controlnets"]
        return data

    @model_serializer(mode="wrap")
    def serialize_model(self, serializer, info):
        """Exclude None values when serializing."""
        data = serializer(self)
        return {k: v for k, v in data.items() if v is not None}
