"""
encoders.py

Pluggable image+text encoder layer. Each backend produces L2-normalized
embeddings in a shared image/text space. The factory `build_encoder()` resolves
a string spec like ``"openai-clip:ViT-B/32"`` or ``"siglip:google/siglip2-..."``
to a concrete encoder.

Existing albums and .npz caches default to the original OpenAI CLIP ``ViT-B/32``
weights, so behavior is unchanged unless an album opts in to a different spec.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

import numpy as np
import torch
from PIL import Image

DEFAULT_ENCODER_SPEC = "openai-clip:ViT-B/32"


class EmbeddingCacheMismatch(RuntimeError):
    """Raised when an .npz cache was produced by a different encoder than the active one."""

    def __init__(self, stored: str, current: str, path: str | None = None):
        self.stored = stored
        self.current = current
        self.path = path
        location = f" at {path}" if path else ""
        super().__init__(
            f"Embedding cache{location} was built with encoder {stored!r} "
            f"but the active encoder is {current!r}. Re-index the album to rebuild it."
        )


class ImageTextEncoder(ABC):
    """Image+text encoder producing L2-normalized embeddings in a shared space."""

    model_id: str
    embedding_dim: int
    device: str

    @abstractmethod
    def encode_images(self, images: list[Image.Image]) -> np.ndarray:
        """Encode a batch of PIL images. Returns ``(N, D)`` float32 L2-normalized array."""

    @abstractmethod
    def encode_text(self, texts: list[str]) -> np.ndarray:
        """Encode a batch of strings. Returns ``(N, D)`` float32 L2-normalized array."""

    def close(self) -> None:  # noqa: B027
        """Release model weights and free GPU memory.

        Default no-op so subclasses without weights to free aren't forced to override.
        """


class OpenAIClipEncoder(ImageTextEncoder):
    """Original OpenAI CLIP via the ``clip`` package — preserves legacy behavior."""

    def __init__(
        self,
        variant: str = "ViT-B/32",
        device: str | None = None,
        download_root: str | None = None,
    ):
        try:
            import clip  # type: ignore[import-not-found]
        except ImportError as e:
            raise ImportError(
                "openai-clip backend requires the `clip-anytorch` package."
            ) from e

        self._clip = clip
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self._model, self._preprocess = clip.load(
            variant, device=self.device, download_root=download_root
        )
        self._model.eval()
        self.model_id = f"openai-clip:{variant}"
        self.embedding_dim = int(self._model.visual.output_dim)

    @torch.no_grad()
    def encode_images(self, images: list[Image.Image]) -> np.ndarray:
        batch = torch.stack(
            [self._preprocess(img.convert("RGB")) for img in images]
        ).to(self.device)
        feats = self._model.encode_image(batch)
        return _normalize(feats)

    @torch.no_grad()
    def encode_text(self, texts: list[str]) -> np.ndarray:
        tokens = self._clip.tokenize(texts, truncate=True).to(self.device)
        feats = self._model.encode_text(tokens)
        return _normalize(feats)

    def close(self) -> None:
        if hasattr(self, "_model"):
            del self._model
        if hasattr(self, "_preprocess"):
            del self._preprocess
        _free_cuda(self.device)


class OpenClipEncoder(ImageTextEncoder):
    """OpenCLIP — same architecture as CLIP, better-trained weights (DFN, MetaCLIP, LAION)."""

    def __init__(
        self,
        model_name: str = "ViT-L-14",
        pretrained: str = "openai",
        device: str | None = None,
        cache_dir: str | None = None,
    ):
        try:
            import open_clip  # type: ignore[import-not-found]
        except ImportError as e:
            raise ImportError(
                "open-clip backend requires the `open_clip_torch` package. "
                "Install it with: pip install photomap[open-clip]"
            ) from e

        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self._model, _, self._preprocess = open_clip.create_model_and_transforms(
            model_name, pretrained=pretrained, device=self.device, cache_dir=cache_dir
        )
        self._tokenizer = open_clip.get_tokenizer(model_name)
        self._model.eval()
        self.model_id = f"open-clip:{model_name}/{pretrained}"
        self.embedding_dim = int(self._model.visual.output_dim)

    @torch.no_grad()
    def encode_images(self, images: list[Image.Image]) -> np.ndarray:
        batch = torch.stack(
            [self._preprocess(img.convert("RGB")) for img in images]
        ).to(self.device)
        feats = self._model.encode_image(batch)
        return _normalize(feats)

    @torch.no_grad()
    def encode_text(self, texts: list[str]) -> np.ndarray:
        tokens = self._tokenizer(texts).to(self.device)
        feats = self._model.encode_text(tokens)
        return _normalize(feats)

    def close(self) -> None:
        for attr in ("_model", "_preprocess", "_tokenizer"):
            if hasattr(self, attr):
                delattr(self, attr)
        _free_cuda(self.device)


class SiglipEncoder(ImageTextEncoder):
    """SigLIP / SigLIP 2 via Transformers — sigmoid loss, calibrated similarity."""

    def __init__(
        self,
        hf_id: str = "google/siglip2-large-patch16-256",
        device: str | None = None,
    ):
        try:
            from transformers import AutoModel, AutoProcessor  # type: ignore[import-not-found]
        except ImportError as e:
            raise ImportError(
                "siglip backend requires the `transformers` package. "
                "Install it with: pip install photomap[siglip]"
            ) from e

        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self._model = AutoModel.from_pretrained(hf_id).to(self.device).eval()
        self._processor = AutoProcessor.from_pretrained(hf_id)
        self.model_id = f"siglip:{hf_id}"
        self.embedding_dim = int(self._model.config.text_config.hidden_size)

    @torch.no_grad()
    def encode_images(self, images: list[Image.Image]) -> np.ndarray:
        inputs = self._processor(
            images=[img.convert("RGB") for img in images], return_tensors="pt"
        ).to(self.device)
        feats = self._model.get_image_features(**inputs)
        return _normalize(feats)

    @torch.no_grad()
    def encode_text(self, texts: list[str]) -> np.ndarray:
        inputs = self._processor(
            text=texts, padding="max_length", truncation=True, return_tensors="pt"
        ).to(self.device)
        feats = self._model.get_text_features(**inputs)
        return _normalize(feats)

    def close(self) -> None:
        for attr in ("_model", "_processor"):
            if hasattr(self, attr):
                delattr(self, attr)
        _free_cuda(self.device)


def _normalize(feats: torch.Tensor) -> np.ndarray:
    feats = feats / feats.norm(dim=-1, keepdim=True)
    return feats.cpu().float().numpy()


def _free_cuda(device: str) -> None:
    if device.startswith("cuda"):
        torch.cuda.empty_cache()


def build_encoder(spec: str | None = None, **kwargs) -> ImageTextEncoder:
    """Resolve an encoder spec to a concrete encoder.

    Spec format is ``"<backend>:<model>"``. Supported backends:

    - ``openai-clip:<variant>``         e.g. ``openai-clip:ViT-B/32``
    - ``open-clip:<model>/<pretrained>`` e.g. ``open-clip:ViT-L-14/dfn2b``
    - ``siglip:<hf_id>``                e.g. ``siglip:google/siglip2-large-patch16-256``

    A ``None`` or empty spec resolves to ``DEFAULT_ENCODER_SPEC``.
    """
    spec = spec or DEFAULT_ENCODER_SPEC
    backend, _, rest = spec.partition(":")
    if not rest:
        raise ValueError(f"Encoder spec {spec!r} is missing a model identifier")

    if backend == "openai-clip":
        return OpenAIClipEncoder(variant=rest, **kwargs)
    if backend == "open-clip":
        name, _, pretrained = rest.partition("/")
        if not pretrained:
            raise ValueError(
                f"open-clip spec must be 'open-clip:<model>/<pretrained>', got {spec!r}"
            )
        return OpenClipEncoder(model_name=name, pretrained=pretrained, **kwargs)
    if backend == "siglip":
        return SiglipEncoder(hf_id=rest, **kwargs)

    raise ValueError(f"Unknown encoder backend in spec {spec!r}")
