"""
Version-agnostic view over a parsed GenerationMetadata object.

The new invoke metadata system uses a Pydantic discriminated union over
``GenerationMetadata2`` / ``GenerationMetadata3`` / ``GenerationMetadata5``.
Each version stores the same logical pieces of information (prompt, model,
seed, LoRAs, reference images, control layers, raster images) in structurally
different places.

``InvokeMetadataView`` is the public facade — it exposes a flat, stable
interface so ``invoke_formatter`` and the recall router stay ignorant of the
version layout. The version-specific extraction rules live in
``_VersionStrategy`` subclasses (one per ``GenerationMetadataN``), picked at
construction time by ``_pick``. Adding a new InvokeAI metadata version means:

1. Add a new ``invokeNmetadata.py`` schema (already needed for the
   discriminated union itself).
2. Add a new ``_VnStrategy(_V3PlusStrategy or _VersionStrategy)`` subclass
   that overrides only the methods whose behaviour differs from v3.
3. Add a branch in ``_pick``.

The facade itself doesn't change.
"""

from abc import ABC, abstractmethod
from collections import namedtuple

from .canvas2metadata import CanvasV2Metadata
from .common_metadata_elements import (
    ControlAdapter,
    ImageFile,
    IPAdapter,
)
from .common_metadata_elements import Image as CommonImage
from .invoke2metadata import GenerationMetadata2
from .invoke2metadata import Prompt as V2Prompt
from .invoke3metadata import GenerationMetadata3
from .invoke5metadata import ControlLayer as V5ControlLayer
from .invoke5metadata import GenerationMetadata5, RefImage

LoraTuple = namedtuple("LoraTuple", ["model_name", "weight"])
ReferenceImageTuple = namedtuple(
    "ReferenceImageTuple", ["model_name", "image_name", "weight"]
)
ControlLayerTuple = namedtuple(
    "ControlLayerTuple", ["model_name", "image_name", "weight"]
)

GenerationMetadataT = GenerationMetadata2 | GenerationMetadata3 | GenerationMetadata5


# ---------------------------------------------------------------------------
# Module-level helpers shared by the strategy classes
# ---------------------------------------------------------------------------


def _image_name(image: CommonImage | None) -> str:
    """Return the stored image name for an Image, or '' if unavailable.

    The discriminated ``Image`` union can be either an ``ImageFile`` (which
    carries a ``name``) or an ``ImageData`` (inline data URL, no name).
    """
    if isinstance(image, ImageFile):
        return image.name or ""
    return ""


def _effective_weight(
    weight: float | None, image_influence: str | None
) -> float | str | None:
    """Return the value to display in the weight column of a tuple table.

    Most InvokeAI IP-adapter-style reference images carry a numeric
    ``weight``. Flux Redux adapters, however, don't use a numeric weight —
    they use a categorical ``image_influence`` field with values like
    ``"Low"``, ``"Medium"``, ``"High"``. When ``weight`` is absent we fall
    back to ``image_influence`` so the column remains meaningful.
    """
    if weight is not None:
        return weight
    return image_influence


def _ipadapter_to_tuple(ipa: IPAdapter) -> ReferenceImageTuple:
    return ReferenceImageTuple(
        model_name=ipa.model.name if ipa.model else "",
        image_name=_image_name(ipa.image),
        weight=_effective_weight(ipa.weight, ipa.image_influence),
    )


def _refimage_to_tuple(ref: RefImage) -> ReferenceImageTuple:
    cfg = ref.config
    model_name = cfg.model.name if cfg.model else ""
    # Weight is only meaningful for IP-adapter references. Reference images
    # that attach directly to the model (Flux2, Qwen, etc.) have no IP adapter
    # — ``cfg.model`` is None — and any ``weight`` value InvokeAI serializes
    # for them is an internal default rather than a user-set value, so
    # suppress it.
    if cfg.model is None:
        weight: float | str | None = None
    else:
        weight = _effective_weight(cfg.weight, cfg.image_influence)
    return ReferenceImageTuple(
        model_name=model_name,
        image_name=_image_name(cfg.image),
        weight=weight,
    )


def _canvas_reference_images(canvas: CanvasV2Metadata) -> list[ReferenceImageTuple]:
    result: list[ReferenceImageTuple] = []
    for ref in canvas.reference_images or []:
        if ref.is_enabled is False:
            continue
        ipa = ref.ip_adapter
        result.append(
            ReferenceImageTuple(
                model_name=ipa.model.name if ipa.model else "",
                image_name=_image_name(ipa.image),
                weight=_effective_weight(ipa.weight, ipa.image_influence),
            )
        )
    return result


def _control_adapter_to_tuple(ca: ControlAdapter) -> ControlLayerTuple:
    return ControlLayerTuple(
        model_name=ca.model.name if ca.model else "",
        image_name=_image_name(ca.image),
        weight=ca.weight,
    )


def _v5_control_layer_to_tuple(layer: V5ControlLayer) -> ControlLayerTuple:
    ca = layer.control_adapter
    assert ca is not None  # caller filters this
    return ControlLayerTuple(
        model_name=ca.model.name if ca.model else "",
        image_name=_image_name(ca.image),
        weight=_effective_weight(ca.weight, ca.image_influence),
    )


def _canvas_control_layers(canvas: CanvasV2Metadata) -> list[ControlLayerTuple]:
    result: list[ControlLayerTuple] = []
    for layer in canvas.control_layers or []:
        if not layer.is_enabled:
            continue
        ca = layer.control_adapter
        image_names = [
            _image_name(obj.image)
            for obj in layer.objects
            if obj.image is not None
        ]
        image_names = [n for n in image_names if n]
        result.append(
            ControlLayerTuple(
                model_name=ca.model.name if ca.model else "",
                image_name=", ".join(image_names),
                weight=ca.weight,
            )
        )
    return result


# Recall-payload scalar fields shared by v3 and v5. Each ``(attr, key)`` pair
# is read off the metadata via getattr and added to the payload when present.
_RECALL_V3PLUS_SCALARS: tuple[tuple[str, str], ...] = (
    ("steps", "steps"),
    ("cfg_scale", "cfg_scale"),
    ("cfg_rescale_multiplier", "cfg_rescale_multiplier"),
    ("guidance", "guidance"),
    ("width", "width"),
    ("height", "height"),
    ("scheduler", "scheduler"),
    ("clip_skip", "clip_skip"),
    ("seamless_x", "seamless_x"),
    ("seamless_y", "seamless_y"),
)

# v5-only refiner fields, layered on top of the v3+ block.
_RECALL_V5_REFINER: tuple[tuple[str, str], ...] = (
    ("refiner_cfg_scale", "refiner_cfg_scale"),
    ("refiner_steps", "refiner_steps"),
    ("refiner_start", "refiner_denoise_start"),
    ("refiner_positive_aesthetic_score", "refiner_positive_aesthetic_score"),
    ("refiner_negative_aesthetic_score", "refiner_negative_aesthetic_score"),
    ("strength", "denoise_strength"),
)


def _copy_scalars(
    metadata: object, payload: dict, fields: tuple[tuple[str, str], ...]
) -> None:
    """Copy ``(attr, key)`` pairs from ``metadata`` to ``payload`` when set."""
    for attr, key in fields:
        value = getattr(metadata, attr, None)
        if value is not None:
            payload[key] = value


# ---------------------------------------------------------------------------
# Per-version dispatch
# ---------------------------------------------------------------------------


class _VersionStrategy(ABC):
    """Per-version extraction rules. One subclass per ``GenerationMetadataN``.

    Subclasses get ``self.m`` (the parsed metadata) and implement the eight
    field-extraction methods plus an optional ``add_recall_scalars`` hook
    that adds version-specific scalars (steps, cfg_scale, refiner fields, …)
    to the recall payload built by :meth:`InvokeMetadataView.to_recall_payload`.
    """

    def __init__(self, metadata: GenerationMetadataT) -> None:
        self.m = metadata

    @abstractmethod
    def positive_prompt(self) -> str: ...

    @abstractmethod
    def negative_prompt(self) -> str: ...

    @abstractmethod
    def model_name(self) -> str: ...

    @abstractmethod
    def seed(self) -> int | None: ...

    @abstractmethod
    def loras(self) -> list[LoraTuple]: ...

    @abstractmethod
    def reference_images(self) -> list[ReferenceImageTuple]: ...

    @abstractmethod
    def control_layers(self) -> list[ControlLayerTuple]: ...

    @abstractmethod
    def raster_images(self) -> list[str]: ...

    def add_recall_scalars(self, payload: dict) -> None:
        """Add version-specific scalar fields to the recall payload.

        Default no-op (v2 has none); v3 / v5 override.
        """
        return


class _V2Strategy(_VersionStrategy):
    """Legacy InvokeAI v2 — prompts live under ``image``; no LoRAs / refs / control."""

    def positive_prompt(self) -> str:
        if self.m.image is None:
            return ""
        prompt = self.m.image.prompt
        if isinstance(prompt, list):
            if not prompt:
                return ""
            first = prompt[0]
            if isinstance(first, V2Prompt):
                return first.prompt or ""
            return ""
        return prompt or ""

    def negative_prompt(self) -> str:
        return ""

    def model_name(self) -> str:
        return self.m.model_weights or self.m.model or ""

    def seed(self) -> int | None:
        return self.m.image.seed if self.m.image is not None else None

    def loras(self) -> list[LoraTuple]:
        return []

    def reference_images(self) -> list[ReferenceImageTuple]:
        return []

    def control_layers(self) -> list[ControlLayerTuple]:
        return []

    def raster_images(self) -> list[str]:
        return []


class _V3Strategy(_VersionStrategy):
    """InvokeAI v3 — top-level prompts, ip_adapters, controlnets."""

    def positive_prompt(self) -> str:
        return self.m.positive_prompt or ""

    def negative_prompt(self) -> str:
        return self.m.negative_prompt or ""

    def model_name(self) -> str:
        if self.m.model is None:
            return ""
        if isinstance(self.m.model, str):
            return self.m.model
        return self.m.model.name or ""

    def seed(self) -> int | None:
        return self.m.seed

    def loras(self) -> list[LoraTuple]:
        if not self.m.loras:
            return []
        return [
            LoraTuple(model_name=lora.model.name, weight=lora.weight)
            for lora in self.m.loras
        ]

    def reference_images(self) -> list[ReferenceImageTuple]:
        return [_ipadapter_to_tuple(ipa) for ipa in (self.m.ip_adapters or [])]

    def control_layers(self) -> list[ControlLayerTuple]:
        return [_control_adapter_to_tuple(ca) for ca in (self.m.controlnets or [])]

    def raster_images(self) -> list[str]:
        return []

    def add_recall_scalars(self, payload: dict) -> None:
        _copy_scalars(self.m, payload, _RECALL_V3PLUS_SCALARS)


class _V5Strategy(_V3Strategy):
    """InvokeAI v5 — same prompt/model/seed/loras shape as v3, plus canvas_v2 paths.

    Subclasses ``_V3Strategy`` so prompts, model, seed, and loras stay shared.
    Reference images, control layers, raster images, and the refiner scalars
    are v5-specific overrides.
    """

    def reference_images(self) -> list[ReferenceImageTuple]:
        if self.m.ref_images:
            return [
                _refimage_to_tuple(r) for r in self.m.ref_images if r.isEnabled
            ]
        if self.m.canvas_v2_metadata is not None:
            return _canvas_reference_images(self.m.canvas_v2_metadata)
        return []

    def control_layers(self) -> list[ControlLayerTuple]:
        # Prefer top-level control_layers, fall back to canvas_v2_metadata.
        if self.m.control_layers is not None and self.m.control_layers.layers:
            return [
                _v5_control_layer_to_tuple(layer)
                for layer in self.m.control_layers.layers
                if layer.is_enabled and layer.control_adapter is not None
            ]
        if self.m.canvas_v2_metadata is not None:
            return _canvas_control_layers(self.m.canvas_v2_metadata)
        return []

    def raster_images(self) -> list[str]:
        canvas = self.m.canvas_v2_metadata
        if canvas is None or not canvas.raster_layers:
            return []
        result: list[str] = []
        for layer in canvas.raster_layers:
            if not layer.is_enabled:
                continue
            for obj in layer.objects:
                name = _image_name(obj.image) if obj.image is not None else ""
                if name:
                    result.append(name)
        return result

    def add_recall_scalars(self, payload: dict) -> None:
        super().add_recall_scalars(payload)
        _copy_scalars(self.m, payload, _RECALL_V5_REFINER)


def _pick(metadata: GenerationMetadataT) -> _VersionStrategy:
    """Choose the strategy for a parsed metadata instance.

    Pure ``isinstance`` dispatch — the discriminated union has already
    validated the shape upstream, so we just need to map type → strategy.
    """
    if isinstance(metadata, GenerationMetadata2):
        return _V2Strategy(metadata)
    if isinstance(metadata, GenerationMetadata3):
        return _V3Strategy(metadata)
    if isinstance(metadata, GenerationMetadata5):
        return _V5Strategy(metadata)
    raise TypeError(
        f"No InvokeMetadataView strategy registered for {type(metadata).__name__}"
    )


# ---------------------------------------------------------------------------
# Public facade
# ---------------------------------------------------------------------------


class InvokeMetadataView:
    """Read-only facade over a parsed InvokeAI ``GenerationMetadata``.

    Attributes expose exactly the fields required by ``invoke_formatter`` so
    that the formatter stays ignorant of the underlying version layout. The
    actual version-specific extraction happens in the ``_VersionStrategy``
    chosen by ``_pick`` at construction time.
    """

    def __init__(self, metadata: GenerationMetadataT) -> None:
        self.metadata = metadata
        self._strategy = _pick(metadata)

    # ---- field extractors ------------------------------------------------

    @property
    def positive_prompt(self) -> str:
        return self._strategy.positive_prompt()

    @property
    def negative_prompt(self) -> str:
        return self._strategy.negative_prompt()

    @property
    def model_name(self) -> str:
        return self._strategy.model_name()

    @property
    def seed(self) -> int | None:
        return self._strategy.seed()

    @property
    def loras(self) -> list[LoraTuple]:
        return self._strategy.loras()

    @property
    def reference_images(self) -> list[ReferenceImageTuple]:
        return self._strategy.reference_images()

    @property
    def control_layers(self) -> list[ControlLayerTuple]:
        return self._strategy.control_layers()

    @property
    def raster_images(self) -> list[str]:
        return self._strategy.raster_images()

    # ---- recall payload --------------------------------------------------

    def to_recall_payload(self, include_seed: bool = True) -> dict:
        """Build a payload suitable for InvokeAI's ``/api/v1/recall/{queue_id}``.

        The returned dict follows the schema documented in the InvokeAI
        ``RECALL_PARAMETERS`` docs. Fields that the current metadata does not
        carry are simply omitted, so that the receiving InvokeAI backend only
        overwrites values it has been given.

        ``include_seed`` toggles whether the random seed is included. The UI
        uses ``False`` for the "remix" action so that the receiving InvokeAI
        backend re-randomizes the generation.
        """
        payload: dict = {}

        positive = self.positive_prompt
        if positive:
            payload["positive_prompt"] = positive
        negative = self.negative_prompt
        if negative:
            payload["negative_prompt"] = negative

        model_name = self.model_name
        if model_name:
            payload["model"] = model_name

        if include_seed and self.seed is not None:
            payload["seed"] = int(self.seed)

        # Version-specific scalar fields (steps / cfg_scale / refiner …).
        self._strategy.add_recall_scalars(payload)

        loras = [
            {"model_name": lora.model_name, "weight": float(lora.weight)}
            for lora in self.loras
            if lora.model_name
        ]
        if loras:
            payload["loras"] = loras

        control_layers: list[dict] = []
        for layer in self.control_layers:
            if not layer.model_name:
                continue
            entry: dict = {"model_name": layer.model_name}
            if layer.image_name:
                entry["image_name"] = layer.image_name
            if isinstance(layer.weight, int | float):
                entry["weight"] = float(layer.weight)
            control_layers.append(entry)
        if control_layers:
            payload["control_layers"] = control_layers

        ip_adapters: list[dict] = []
        reference_images: list[dict] = []
        for ref in self.reference_images:
            if ref.model_name:
                entry = {"model_name": ref.model_name}
                if ref.image_name:
                    entry["image_name"] = ref.image_name
                if isinstance(ref.weight, int | float):
                    entry["weight"] = float(ref.weight)
                ip_adapters.append(entry)
            elif ref.image_name:
                reference_images.append({"image_name": ref.image_name})
        if ip_adapters:
            payload["ip_adapters"] = ip_adapters
        if reference_images:
            payload["reference_images"] = reference_images

        return payload
