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

import logging
import math
import sys
import threading
import time
from abc import ABC, abstractmethod
from typing import ClassVar

import numpy as np
import torch
from PIL import Image

logger = logging.getLogger(__name__)

# Default encoder for *new* albums. OpenCLIP-DFN ViT-L-14 is the best
# general-purpose pick across our three backends: noticeably stronger recall
# than legacy CLIP, with CLIP-style cosine semantics that work well on
# cluttered real-world photos (where SigLIP's steeper calibration tends to
# misfire).
DEFAULT_ENCODER_SPEC = "open-clip:ViT-L-14/dfn2b_s39b"

# Encoder assumed when a legacy ``.npz`` cache or pre-swap-layer YAML album
# omits the ``model_id`` / ``encoder_spec`` field. Before the encoder swap
# layer existed, legacy CLIP was the only option, so any cache that predates
# the field was unambiguously built with this spec. Don't change this — it's
# a compatibility marker, not a tunable.
LEGACY_ENCODER_SPEC = "openai-clip:ViT-B/32"

# Default encoder for *new* albums on Linux/Windows hosts without CUDA. The
# OpenCLIP ViT-L-14 DEFAULT_ENCODER_SPEC is impractically slow to index/search
# on CPU there, so new albums fall back to the much lighter OpenAI CLIP
# ViT-B/32 (weaker recall, far faster). This happens to be the same spec string
# as LEGACY_ENCODER_SPEC, but it's a distinct constant on purpose: this one is
# a tunable CPU default, not the frozen legacy-cache compatibility marker.
CPU_FALLBACK_ENCODER_SPEC = "openai-clip:ViT-B/32"


def default_encoder_spec() -> str:
    """Resolve the default encoder spec for *new* albums based on the host.

    Hosts with CUDA, and macOS (left on the high-quality default since the
    lighter CPU path is untested there), get ``DEFAULT_ENCODER_SPEC``. Linux and
    Windows hosts without CUDA fall back to ``CPU_FALLBACK_ENCODER_SPEC`` because
    OpenCLIP ViT-L-14 is far too slow to run on CPU on those platforms.
    """
    if torch.cuda.is_available():
        return DEFAULT_ENCODER_SPEC
    if sys.platform == "darwin":
        return DEFAULT_ENCODER_SPEC
    return CPU_FALLBACK_ENCODER_SPEC

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

    # Subclasses override to list the attributes that hold model weights and
    # companion artifacts (preprocessors, tokenizers, processors). The shared
    # ``close()`` walks this tuple, ``delattr``-ing each one present, and then
    # drops the CUDA cache so freed memory is actually reclaimed. Listing the
    # attributes here keeps the three concrete encoders' teardown logic
    # consistent — previously one used ``del`` and the others ``delattr``,
    # and adding a new artifact meant remembering to free it in close().
    _releasable_attrs: ClassVar[tuple[str, ...]] = ()

    @staticmethod
    def _resolve_device(device: str | None) -> str:
        """Pick a torch device string, defaulting to CUDA when available."""
        return device or ("cuda" if torch.cuda.is_available() else "cpu")

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

    def close(self) -> None:
        """Release model weights and free GPU memory.

        Drops each attribute listed in ``_releasable_attrs`` and then frees
        CUDA cache. Subclasses normally don't need to override — declare the
        attribute names instead.
        """
        for attr in self._releasable_attrs:
            if hasattr(self, attr):
                delattr(self, attr)
        _free_cuda(self.device)

    # --- Offload / reload --------------------------------------------------
    # Encoders cached for repeated search use can sit idle for a long time
    # while still pinning multiple GB of VRAM. ``offload()`` moves the model
    # weights to host RAM so other GPU workloads can run; the next call to an
    # ``encode_*`` method transparently reloads them via ``_ensure_on_device``.
    # Reload from RAM is sub-second — much cheaper than the initial Hub fetch
    # and tensor allocation that ``build_encoder`` pays.

    def _device_lock(self) -> threading.RLock:
        """Per-instance reentrant lock guarding offload/reload + encode.

        Lazily created so subclasses that don't call ``super().__init__()``
        (all of the bundled ones) still get a working lock.
        """
        lock = self.__dict__.get("_offload_lock")
        if lock is None:
            lock = threading.RLock()
            self.__dict__["_offload_lock"] = lock
        return lock

    @property
    def is_offloaded(self) -> bool:
        return bool(self.__dict__.get("_offloaded", False))

    def offload(self) -> None:
        """Move model weights from VRAM to host RAM.

        No-op when already offloaded, when running on CPU (nothing to free),
        or when the subclass holds no ``_model`` attribute. Safe to call
        concurrently with encode calls — the encode wrappers take the same
        reentrant lock and will not be interrupted.
        """
        if not self.device.startswith("cuda"):
            return
        with self._device_lock():
            if self.is_offloaded:
                return
            model = getattr(self, "_model", None)
            if model is None:
                return
            try:
                model.to("cpu")
            except Exception:
                logger.exception("Failed to offload encoder %s", self.model_id)
                return
            self.__dict__["_offloaded"] = True
            _free_cuda(self.device)
            logger.info("Offloaded encoder %s from %s to cpu", self.model_id, self.device)

    def _ensure_on_device(self) -> None:
        """If offloaded, move model weights back to ``self.device`` for the next encode."""
        # Stamp every encode call's timestamp so the idle watcher sees activity
        # mid-loop. Without this, `_search_encoder_last_access` only ticks on
        # `get_cached_encoder` calls — a long vocab build does ONE cache lookup
        # then many encodes, so the watcher thinks the encoder is idle and
        # offloads it between batches, forcing a reload on the next encode
        # (~10s thrash cycle observed during 30+ batch vocab rebuilds).
        self.__dict__["_last_use_monotonic"] = time.monotonic()
        if not self.is_offloaded:
            return
        with self._device_lock():
            if not self.is_offloaded:
                return
            model = getattr(self, "_model", None)
            if model is not None:
                model.to(self.device)
            self.__dict__["_offloaded"] = False
            logger.info("Reloaded encoder %s onto %s", self.model_id, self.device)


class OpenAIClipEncoder(ImageTextEncoder):
    """Original OpenAI CLIP via the ``clip`` package — preserves legacy behavior."""

    _releasable_attrs = ("_model", "_preprocess")

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
        self.device = self._resolve_device(device)
        self._model, self._preprocess = clip.load(
            variant, device=self.device, download_root=download_root
        )
        self._model.eval()
        self.model_id = f"openai-clip:{variant}"
        self.embedding_dim = int(self._model.visual.output_dim)

    @torch.no_grad()
    def encode_images(self, images: list[Image.Image]) -> np.ndarray:
        with self._device_lock():
            self._ensure_on_device()
            batch = torch.stack(
                [self._preprocess(img.convert("RGB")) for img in images]
            ).to(self.device)
            feats = self._model.encode_image(batch)
            return _normalize(feats)

    @torch.no_grad()
    def encode_text(self, texts: list[str]) -> np.ndarray:
        with self._device_lock():
            self._ensure_on_device()
            tokens = self._clip.tokenize(texts, truncate=True).to(self.device)
            feats = self._model.encode_text(tokens)
            return _normalize(feats)

class OpenClipEncoder(ImageTextEncoder):
    """OpenCLIP — same architecture as CLIP, better-trained weights (DFN, MetaCLIP, LAION)."""

    _releasable_attrs = ("_model", "_preprocess", "_tokenizer")

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

        self.device = self._resolve_device(device)
        self._model, _, self._preprocess = open_clip.create_model_and_transforms(
            model_name, pretrained=pretrained, device=self.device, cache_dir=cache_dir
        )
        self._tokenizer = open_clip.get_tokenizer(model_name)
        self._model.eval()
        self.model_id = f"open-clip:{model_name}/{pretrained}"
        self.embedding_dim = int(self._model.visual.output_dim)

    @torch.no_grad()
    def encode_images(self, images: list[Image.Image]) -> np.ndarray:
        with self._device_lock():
            self._ensure_on_device()
            batch = torch.stack(
                [self._preprocess(img.convert("RGB")) for img in images]
            ).to(self.device)
            feats = self._model.encode_image(batch)
            return _normalize(feats)

    @torch.no_grad()
    def encode_text(self, texts: list[str]) -> np.ndarray:
        with self._device_lock():
            self._ensure_on_device()
            tokens = self._tokenizer(texts).to(self.device)
            feats = self._model.encode_text(tokens)
            return _normalize(feats)

class SiglipEncoder(ImageTextEncoder):
    """SigLIP / SigLIP 2 via Transformers — sigmoid loss, calibrated similarity."""

    _releasable_attrs = ("_model", "_processor")

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

        self.device = self._resolve_device(device)
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
        with self._device_lock():
            self._ensure_on_device()
            inputs = self._processor(
                images=[img.convert("RGB") for img in images], return_tensors="pt"
            ).to(self.device)
            feats = self._model.get_image_features(**inputs)
            return _normalize(_unwrap_pooled(feats))

    @torch.no_grad()
    def encode_text(self, texts: list[str]) -> np.ndarray:
        with self._device_lock():
            self._ensure_on_device()
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
_search_encoder_last_access: dict[tuple[str, str | None], float] = {}
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

    Each call refreshes the entry's idle timestamp so the background watcher
    started by :func:`start_idle_watcher` won't offload an encoder that's
    actively being queried.
    """
    resolved_spec = spec or DEFAULT_ENCODER_SPEC
    key = (resolved_spec, cache_dir)
    with _search_encoder_lock:
        encoder = _search_encoder_cache.get(key)
        if encoder is None:
            encoder = build_encoder(resolved_spec, cache_dir=cache_dir, device=device)
            _search_encoder_cache[key] = encoder
        _search_encoder_last_access[key] = time.monotonic()
    return encoder


def clear_encoder_cache() -> None:
    """Free every cached search encoder. Mostly for tests and memory recovery."""
    with _search_encoder_lock:
        for encoder in _search_encoder_cache.values():
            encoder.close()
        _search_encoder_cache.clear()
        _search_encoder_last_access.clear()


# --- Idle watcher ----------------------------------------------------------
# A single daemon thread monitors ``_search_encoder_last_access`` and offloads
# any cached encoder that's gone untouched for ``timeout`` seconds. The watcher
# is opt-in (started from the FastAPI lifespan) so CLI tools and tests aren't
# burdened with a background thread they don't need.

_idle_watcher_thread: threading.Thread | None = None
_idle_watcher_stop = threading.Event()


def _idle_watcher_loop(timeout_seconds: float, poll_interval: float) -> None:
    while not _idle_watcher_stop.is_set():
        # Event.wait returns True if set during the wait — use it to exit
        # promptly on shutdown rather than sleeping out the full interval.
        if _idle_watcher_stop.wait(poll_interval):
            return
        now = time.monotonic()
        # Snapshot under the lock; release it before calling .offload() so a
        # slow GPU-CPU transfer can't block new search queries from grabbing
        # the cache lock.
        with _search_encoder_lock:
            stale = [
                (key, _search_encoder_cache[key])
                for key, ts in _search_encoder_last_access.items()
                if key in _search_encoder_cache and now - ts >= timeout_seconds
            ]
        for key, encoder in stale:
            # Re-acquire the cache lock around the offload to keep
            # ``clear_encoder_cache`` from concurrently calling ``encoder.close()``
            # on a model the idle watcher is still moving off the GPU. If the
            # encoder is no longer the live cache entry (e.g. the user reloaded
            # an album with a new spec, evicting the old encoder), skip — closing
            # an already-closed model would NPE on ``self._model``.
            with _search_encoder_lock:
                if _search_encoder_cache.get(key) is not encoder:
                    continue
                if encoder.is_offloaded:
                    continue
                # The cache-keyed timestamp only ticks on get_cached_encoder calls,
                # but encoders also update their own `_last_use_monotonic` on every
                # encode (via _ensure_on_device). A long encode loop holds the
                # encoder hot via the latter even though the cache stamp is stale.
                last_use = getattr(encoder, "_last_use_monotonic", 0.0)
                if now - last_use < timeout_seconds:
                    continue
                try:
                    encoder.offload()
                except Exception:
                    logger.exception("Idle watcher failed to offload encoder")


def start_idle_watcher(timeout_seconds: float, poll_interval: float | None = None) -> None:
    """Start the background thread that offloads idle search encoders.

    ``timeout_seconds`` is the inactivity threshold. ``0`` disables the
    watcher entirely. ``poll_interval`` defaults to ``min(timeout/2, 5.0)`` so
    a stale encoder is detected within roughly one half-life of the timeout
    without busy-waking on tight schedules.

    Idempotent: a second call replaces the running watcher with one that
    honours the new timeout.
    """
    global _idle_watcher_thread
    stop_idle_watcher()
    if timeout_seconds <= 0:
        return
    interval = poll_interval if poll_interval is not None else min(timeout_seconds / 2, 5.0)
    interval = max(interval, 0.1)
    _idle_watcher_stop.clear()
    thread = threading.Thread(
        target=_idle_watcher_loop,
        args=(timeout_seconds, interval),
        name="encoder-idle-watcher",
        daemon=True,
    )
    thread.start()
    _idle_watcher_thread = thread
    logger.info(
        "Encoder idle watcher started (timeout=%.1fs, poll=%.2fs)",
        timeout_seconds,
        interval,
    )


def stop_idle_watcher() -> None:
    """Signal the idle watcher to stop and wait for it to exit."""
    global _idle_watcher_thread
    thread = _idle_watcher_thread
    if thread is None:
        return
    _idle_watcher_stop.set()
    thread.join(timeout=5.0)
    _idle_watcher_thread = None
