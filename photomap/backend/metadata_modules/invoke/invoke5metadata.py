from typing import Any, Literal

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
    control_adapter: IPAdapter | None = Field(default=None, alias="ipAdapter")


class ControlLayers(BaseModel):
    version: int | float
    layers: list[ControlLayer]


class ControlNet(BaseModel):
    image: Image
    model: Model = Field(alias="control_model")
    weight: float | None = Field(alias="control_weight")
    begin_end_step_pct: list[int | float] | None = Field(
        None, alias="beginEndStepPct"
    )
    control_mode: str
    resize_mode: str

    @model_validator(mode="before")
    @classmethod
    def fixup_step_percentages(cls, json_data: dict[str, Any]) -> dict[str, Any]:
        """Convert begin_step_percent and end_step_percent to beginEndStepPct if they exist, and ensure the values are in a list."""
        return fixup_step_percentages(json_data)


class RefImageConfig(BaseModel):
    type: str
    image: Image
    model: Model | None = None
    beginEndStepPct: list[float] | None = None
    method: str | None = None
    clipVisionModel: str | None = None
    weight: float | None = None
    image_influence: str | None = Field(default=None, alias="imageInfluence")


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
    model_config = ConfigDict(extra="allow", populate_by_name=True)
    metadata_version: Literal[5]
    app_version: str | None = Field(default="5.X.X")
    model: Model | str | None = Field(default=None, alias="Model")
    generation_mode: str | None = None
    height: int | None = None
    width: int | None = None
    positive_prompt: str | None = Field(default=None, alias="Positive Prompt")
    positive_style_prompt: str | None = None
    negative_prompt: str | None = None
    negative_style_prompt: str | None = None
    scheduler: str | None = None
    seed: int | None = None
    steps: int | None = Field(default=None, alias="Steps")
    guidance: int | float | None = None
    ref_images: list[RefImage] | None = None
    control_layers: ControlLayers | None = Field(default=None)
    loras: list[Lora] | None = None
    regions: list[RegionalGuidance] | None = None
    t5_encoder: T5Encoder | None = None
    qwen3_encoder: Model | None = None
    qwen3_source: Model | None = None
    qwen_image_component_source: Model | None = None
    qwen_image_quantization: str | None = None
    qwen_image_shift: int | float | None = None
    vae: Model | None = None
    clip_embed_model: ClipEmbedModel | None = None
    dype_preset: str | None = None
    rand_device: str | None = None
    cfg_scale: float | None = None
    cfg_rescale_multiplier: float | None = None
    seamless_x: bool | None = None
    seamless_y: bool | None = None
    upscale_model: Model | None = None
    upscale_initial_image: Image | None = None
    upscale_scale: float | None = None
    creativity: float | None = None
    structure: float | None = None
    tile_size: int | None = None
    tile_overlap: int | None = None
    clip_skip: int | None = None
    canvas_v2_metadata: CanvasV2Metadata | None = None
    # These fields appear in some ZiT images
    seed_variance_strength: float | None = None
    seed_variance_enabled: bool | None = Field(
        default=None, alias="z_image_seed_variance_enabled"
    )
    seed_variance_randomize_percentage: int | None = Field(
        default=None, alias="z_image_seed_variance_randomize_percentage"
    )
    # These fields appear in some Flux.1 images
    dype_scale: float | None = None
    dype_exponent: float | None = None
    # These fields appear in some sdxl images
    strength: float | None = None
    init_image: str | None = None
    hrf_enabled: bool | None = None
    hrf_method: str | None = None
    hrf_strength: float | None = None
    refiner_cfg_scale: float | None = None
    refiner_steps: int | None = None
    refiner_scheduler: str | None = None
    refiner_positive_aesthetic_score: float | None = None
    refiner_negative_aesthetic_score: float | None = None
    refiner_start: float | None = None

    @model_validator(mode="before")
    @classmethod
    def normalize_ref_images(cls, data):
        """Flatten legacy ``ref_images`` structures before validation.

        Two historical quirks are handled here:

        * In some versions, ``ref_images`` was serialized as a list of lists.
          Flatten the outer wrapper to a plain list.
        * Earlier metadata nested the image under
          ``config.image.original.image``; collapse that down to
          ``config.image``.
        """
        if not isinstance(data, dict):
            return data
        ref_images = data.get("ref_images")
        if not isinstance(ref_images, list) or not ref_images:
            return data

        # Flatten list-of-lists wrapper
        if isinstance(ref_images[0], list):
            ref_images = ref_images[0]

        # Unwrap nested ``config.image.original.image`` structures
        for ref_image in ref_images:
            if not isinstance(ref_image, dict):
                continue
            config = ref_image.get("config")
            if not isinstance(config, dict):
                continue
            image_obj = config.get("image")
            if not isinstance(image_obj, dict):
                continue
            original = image_obj.get("original")
            if isinstance(original, dict) and "image" in original:
                config["image"] = original["image"]

        data["ref_images"] = ref_images
        return data

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
    def fixup_controlnets(cls, data: dict[str, Any]) -> dict[str, Any]:
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
