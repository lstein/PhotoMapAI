"""
Version-agnostic view over a parsed GenerationMetadata object.

The new invoke metadata system uses a Pydantic discriminated union over
``GenerationMetadata2`` / ``GenerationMetadata3`` / ``GenerationMetadata5``.
Each version stores the same logical pieces of information (prompt, model,
seed, LoRAs, reference images, control layers, raster images) in structurally
different places. Rather than sprinkling ``isinstance`` checks throughout the
formatter, this module centralizes the version-specific extraction rules in a
single ``InvokeMetadataView`` class that exposes a flat, stable interface for
the formatter to consume.
"""

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


class InvokeMetadataView:
    """Read-only facade over a parsed InvokeAI ``GenerationMetadata``.

    Attributes expose exactly the fields required by ``invoke_formatter`` so
    that the formatter stays ignorant of the underlying version layout.
    """

    def __init__(self, metadata: GenerationMetadataT) -> None:
        self.metadata = metadata

    # ---- prompts ---------------------------------------------------------

    @property
    def positive_prompt(self) -> str:
        m = self.metadata
        if isinstance(m, GenerationMetadata2):
            if m.image is None:
                return ""
            prompt = m.image.prompt
            if isinstance(prompt, list):
                if not prompt:
                    return ""
                first = prompt[0]
                if isinstance(first, V2Prompt):
                    return first.prompt or ""
                return ""
            return prompt or ""
        return m.positive_prompt or ""

    @property
    def negative_prompt(self) -> str:
        m = self.metadata
        if isinstance(m, GenerationMetadata2):
            return ""
        return m.negative_prompt or ""

    # ---- model / seed ----------------------------------------------------

    @property
    def model_name(self) -> str:
        m = self.metadata
        if isinstance(m, GenerationMetadata2):
            return m.model_weights or m.model or ""
        if m.model is None:
            return ""
        if isinstance(m.model, str):
            return m.model
        return m.model.name or ""

    @property
    def seed(self) -> int | None:
        m = self.metadata
        if isinstance(m, GenerationMetadata2):
            return m.image.seed if m.image is not None else None
        return m.seed

    # ---- loras -----------------------------------------------------------

    @property
    def loras(self) -> list[LoraTuple]:
        m = self.metadata
        if isinstance(m, GenerationMetadata2):
            return []
        if not m.loras:
            return []
        return [
            LoraTuple(model_name=lora.model.name, weight=lora.weight) for lora in m.loras
        ]

    # ---- reference images (IPAdapter) ------------------------------------

    @property
    def reference_images(self) -> list[ReferenceImageTuple]:
        m = self.metadata
        if isinstance(m, GenerationMetadata2):
            return []
        if isinstance(m, GenerationMetadata3):
            return [
                self._ipadapter_to_tuple(ipa)
                for ipa in (m.ip_adapters or [])
            ]
        # v5
        if m.ref_images:
            return [self._refimage_to_tuple(r) for r in m.ref_images if r.isEnabled]
        if m.canvas_v2_metadata is not None:
            return self._canvas_reference_images(m.canvas_v2_metadata)
        return []

    @staticmethod
    def _ipadapter_to_tuple(ipa: IPAdapter) -> ReferenceImageTuple:
        return ReferenceImageTuple(
            model_name=ipa.model.name if ipa.model else "",
            image_name=_image_name(ipa.image),
            weight=_effective_weight(ipa.weight, ipa.image_influence),
        )

    @staticmethod
    def _refimage_to_tuple(ref: RefImage) -> ReferenceImageTuple:
        cfg = ref.config
        model_name = cfg.model.name if cfg.model else ""
        return ReferenceImageTuple(
            model_name=model_name,
            image_name=_image_name(cfg.image),
            weight=_effective_weight(cfg.weight, cfg.image_influence),
        )

    @staticmethod
    def _canvas_reference_images(
        canvas: CanvasV2Metadata,
    ) -> list[ReferenceImageTuple]:
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

    # ---- control layers --------------------------------------------------

    @property
    def control_layers(self) -> list[ControlLayerTuple]:
        m = self.metadata
        if isinstance(m, GenerationMetadata2):
            return []
        if isinstance(m, GenerationMetadata3):
            return [
                self._control_adapter_to_tuple(ca)
                for ca in (m.controlnets or [])
            ]
        # v5 — prefer top-level control_layers, fall back to canvas_v2_metadata
        if m.control_layers is not None and m.control_layers.layers:
            return [
                self._v5_control_layer_to_tuple(layer)
                for layer in m.control_layers.layers
                if layer.is_enabled and layer.control_adapter is not None
            ]
        if m.canvas_v2_metadata is not None:
            return self._canvas_control_layers(m.canvas_v2_metadata)
        return []

    @staticmethod
    def _control_adapter_to_tuple(ca: ControlAdapter) -> ControlLayerTuple:
        return ControlLayerTuple(
            model_name=ca.model.name if ca.model else "",
            image_name=_image_name(ca.image),
            weight=ca.weight,
        )

    @staticmethod
    def _v5_control_layer_to_tuple(layer: V5ControlLayer) -> ControlLayerTuple:
        ca = layer.control_adapter
        assert ca is not None  # caller filters this
        return ControlLayerTuple(
            model_name=ca.model.name if ca.model else "",
            image_name=_image_name(ca.image),
            weight=_effective_weight(ca.weight, ca.image_influence),
        )

    @staticmethod
    def _canvas_control_layers(
        canvas: CanvasV2Metadata,
    ) -> list[ControlLayerTuple]:
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

    # ---- raster images ---------------------------------------------------

    @property
    def raster_images(self) -> list[str]:
        m = self.metadata
        if not isinstance(m, GenerationMetadata5):
            return []
        canvas = m.canvas_v2_metadata
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
