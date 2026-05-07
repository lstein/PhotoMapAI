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

import math
import threading
from abc import ABC, abstractmethod

import numpy as np
import torch
from PIL import Image

DEFAULT_ENCODER_SPEC = "openai-clip:ViT-B/32"

# When True, SigLIP's encode_text wraps each query in every entry of
# SIGLIP_PROMPT_TEMPLATES, encodes them all, L2-normalizes each per-template
# embedding, mean-pools across templates, and re-normalizes. Intended to make
# bare-noun queries match better and to avoid penalizing non-photo content,
# but the practical results are mixed — disabled by default while we evaluate.
SIGLIP_USE_PROMPT_ENSEMBLING = False
#SIGLIP_USE_PROMPT_ENSEMBLING = True

# Modality-spanning prompt templates ensembled by SigLIP at query time when
# SIGLIP_USE_PROMPT_ENSEMBLING is True.
SIGLIP_PROMPT_TEMPLATES = (
    "a photo of {}",
    "a drawing of {}",
    "an illustration of {}",
    "a painting of {}",
    "{}",
)


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

    def calibrate_similarity(self, cosines: np.ndarray) -> np.ndarray:
        """Map raw cosine similarities to a comparable score in roughly ``[0, 1]``.

        Default implementation is the identity, which is appropriate for CLIP-style
        contrastive encoders whose cosine scores are already in a usable range.
        SigLIP overrides this to apply the learned sigmoid calibration so a single
        threshold (e.g. 0.2) produces sane recall across encoder choices.
        """
        return cosines

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
                "open-clip backend requires the `open_clip_torch` package."
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
                "siglip backend requires the `transformers` package."
            ) from e

        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self._model = AutoModel.from_pretrained(hf_id).to(self.device).eval()
        self._processor = AutoProcessor.from_pretrained(hf_id)
        self.model_id = f"siglip:{hf_id}"
        self.embedding_dim = int(self._model.config.text_config.hidden_size)

        # SigLIP applies sigmoid(cos * exp(logit_scale) + logit_bias) to turn
        # cosine similarities into calibrated match probabilities. Capture the
        # learned scalars here so calibrate_similarity() can do the transform
        # without holding a reference to the live model.
        scale_param = getattr(self._model, "logit_scale", None)
        bias_param = getattr(self._model, "logit_bias", None)
        self._logit_scale = (
            float(scale_param.detach().cpu().item()) if scale_param is not None else None
        )
        self._logit_bias = (
            float(bias_param.detach().cpu().item()) if bias_param is not None else 0.0
        )

        # Per-instance toggle for prompt ensembling. The search code mutates
        # this from the album's ``use_query_optimization`` setting before
        # calling encode_text, so different albums sharing this cached
        # encoder still get the behavior they asked for. Defaults to the
        # module-level flag for non-search callers (CLI tools, indexing).
        self.use_ensembling = SIGLIP_USE_PROMPT_ENSEMBLING

    @torch.no_grad()
    def encode_images(self, images: list[Image.Image]) -> np.ndarray:
        inputs = self._processor(
            images=[img.convert("RGB") for img in images], return_tensors="pt"
        ).to(self.device)
        feats = self._model.get_image_features(**inputs)
        return _normalize(_unwrap_pooled(feats))

    @torch.no_grad()
    def encode_text(self, texts: list[str]) -> np.ndarray:
        if self.use_ensembling:
            # Prompt ensembling: encode each input wrapped in every template,
            # L2-normalize each per-template embedding so longer phrasings
            # can't dominate via larger magnitudes, then mean-pool across
            # templates and re-normalize. Standard zero-shot CLIP/SigLIP
            # practice.
            n_templates = len(SIGLIP_PROMPT_TEMPLATES)
            expanded = [
                tpl.format(t) for t in texts for tpl in SIGLIP_PROMPT_TEMPLATES
            ]
            inputs = self._processor(
                text=expanded, padding="max_length", truncation=True, return_tensors="pt"
            ).to(self.device)
            feats = _unwrap_pooled(self._model.get_text_features(**inputs))
            feats = feats / feats.norm(dim=-1, keepdim=True)
            feats = feats.view(len(texts), n_templates, -1).mean(dim=1)
            return _normalize(feats)

        inputs = self._processor(
            text=texts, padding="max_length", truncation=True, return_tensors="pt"
        ).to(self.device)
        feats = self._model.get_text_features(**inputs)
        return _normalize(_unwrap_pooled(feats))

    def calibrate_similarity(self, cosines: np.ndarray) -> np.ndarray:
        """Apply SigLIP's learned sigmoid calibration.

        SigLIP's training objective produces image-text cosines of order 0.05-0.20
        for matching pairs — much smaller than CLIP's 0.20-0.35 range. Without
        calibration, a CLIP-tuned threshold like 0.2 filters out almost every
        true match. The model's ``logit_scale`` and ``logit_bias`` recover
        per-pair match probabilities via ``sigmoid(cos * exp(scale) + bias)``,
        which restores comparable threshold semantics across encoders.
        """
        if self._logit_scale is None:
            return cosines
        scale = math.exp(self._logit_scale)
        logits = cosines * scale + self._logit_bias
        # Stable sigmoid that handles large negative logits without overflow.
        return np.where(
            logits >= 0,
            1.0 / (1.0 + np.exp(-logits)),
            np.exp(logits) / (1.0 + np.exp(logits)),
        )

    def close(self) -> None:
        for attr in ("_model", "_processor"):
            if hasattr(self, attr):
                delattr(self, attr)
        _free_cuda(self.device)


def _unwrap_pooled(feats: object) -> torch.Tensor:
    """Extract a pooled-feature tensor from an HF model's output.

    transformers >= 5 returns ``BaseModelOutputWithPooling`` from
    ``Siglip{,2}Model.get_{image,text}_features``; older versions returned a
    bare tensor. Accept either.
    """
    if isinstance(feats, torch.Tensor):
        return feats
    for attr in ("pooler_output", "image_embeds", "text_embeds", "last_hidden_state"):
        value = getattr(feats, attr, None)
        if isinstance(value, torch.Tensor):
            return value
    raise TypeError(f"Cannot extract pooled features from {type(feats).__name__}")


def _normalize(feats: torch.Tensor) -> np.ndarray:
    feats = feats / feats.norm(dim=-1, keepdim=True)
    return feats.cpu().float().numpy()


def _free_cuda(device: str) -> None:
    if device.startswith("cuda"):
        torch.cuda.empty_cache()


def build_encoder(
    spec: str | None = None,
    *,
    cache_dir: str | None = None,
    device: str | None = None,
) -> ImageTextEncoder:
    """Resolve an encoder spec to a concrete encoder.

    Spec format is ``"<backend>:<model>"``. Supported backends:

    - ``openai-clip:<variant>``         e.g. ``openai-clip:ViT-B/32``
    - ``open-clip:<model>/<pretrained>`` e.g. ``open-clip:ViT-L-14/dfn2b``
    - ``siglip:<hf_id>``                e.g. ``siglip:google/siglip2-large-patch16-256``

    ``cache_dir`` is mapped to each backend's native option (``download_root``
    for OpenAI CLIP, ``cache_dir`` for OpenCLIP). SigLIP uses the standard
    Hugging Face cache (``HF_HOME``/``TRANSFORMERS_CACHE``) and ignores it.

    A ``None`` or empty spec resolves to ``DEFAULT_ENCODER_SPEC``.
    """
    spec = spec or DEFAULT_ENCODER_SPEC
    backend, _, rest = spec.partition(":")
    if not rest:
        raise ValueError(f"Encoder spec {spec!r} is missing a model identifier")

    if backend == "openai-clip":
        return OpenAIClipEncoder(variant=rest, device=device, download_root=cache_dir)
    if backend == "open-clip":
        name, _, pretrained = rest.partition("/")
        if not pretrained:
            raise ValueError(
                f"open-clip spec must be 'open-clip:<model>/<pretrained>', got {spec!r}"
            )
        return OpenClipEncoder(
            model_name=name, pretrained=pretrained, device=device, cache_dir=cache_dir
        )
    if backend == "siglip":
        return SiglipEncoder(hf_id=rest, device=device)

    raise ValueError(f"Unknown encoder backend in spec {spec!r}")


# Module-level encoder cache for query/search workloads. Indexing builds and
# closes its own short-lived encoder; search calls fire many times per session
# and re-running ``AutoModel.from_pretrained`` on each request is both slow
# (HF Hub HEAD checks per file) and noisy. We cache by (spec, cache_dir) and
# leave eviction to ``clear_encoder_cache`` since the working set is small —
# typically one encoder per album in active use.
_search_encoder_cache: dict[tuple[str, str | None], ImageTextEncoder] = {}
_search_encoder_lock = threading.Lock()


def get_cached_encoder(
    spec: str | None = None,
    *,
    cache_dir: str | None = None,
    device: str | None = None,
) -> ImageTextEncoder:
    """Return a process-cached encoder suitable for repeated search queries.

    The first call for a given ``(spec, cache_dir)`` builds the encoder; later
    calls return the same instance. The caller MUST NOT call ``encoder.close()``
    on the result — eviction is the cache's responsibility via
    :func:`clear_encoder_cache`.
    """
    resolved_spec = spec or DEFAULT_ENCODER_SPEC
    key = (resolved_spec, cache_dir)
    with _search_encoder_lock:
        encoder = _search_encoder_cache.get(key)
        if encoder is None:
            encoder = build_encoder(resolved_spec, cache_dir=cache_dir, device=device)
            _search_encoder_cache[key] = encoder
    return encoder


def clear_encoder_cache() -> None:
    """Free every cached search encoder. Mostly for tests and memory recovery."""
    with _search_encoder_lock:
        for encoder in _search_encoder_cache.values():
            encoder.close()
        _search_encoder_cache.clear()
