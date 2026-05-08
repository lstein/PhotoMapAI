"""Unit tests for the pluggable encoder layer.

These tests deliberately avoid loading model weights so they run fast in CI.
End-to-end indexing/search tests live elsewhere and exercise the default
``openai-clip:ViT-B/32`` backend.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from photomap.backend import encoders as encoders_module
from photomap.backend.encoders import (
    DEFAULT_ENCODER_SPEC,
    LEGACY_ENCODER_SPEC,
    EmbeddingCacheMismatch,
    ImageTextEncoder,
    OpenAIClipEncoder,
    OpenClipEncoder,
    SiglipEncoder,
    build_encoder,
    clear_encoder_cache,
    get_cached_encoder,
)


def test_default_spec_for_new_albums():
    """New albums default to OpenCLIP-DFN ViT-L-14 (best general-purpose pick)."""
    assert DEFAULT_ENCODER_SPEC == "open-clip:ViT-L-14/dfn2b_s39b"


def test_legacy_spec_unchanged():
    """LEGACY_ENCODER_SPEC is a compatibility marker for caches that predate
    the encoder swap layer. Don't change this — it's pinned to the original
    CLIP variant that was the only option before the swap layer existed.
    """
    assert LEGACY_ENCODER_SPEC == "openai-clip:ViT-B/32"


def test_build_encoder_resolves_openai_clip(monkeypatch):
    captured: dict[str, object] = {}

    def fake_init(self, variant, device=None, download_root=None):
        captured["variant"] = variant
        captured["device"] = device
        captured["download_root"] = download_root
        self.model_id = f"openai-clip:{variant}"
        self.embedding_dim = 512
        self.device = "cpu"

    monkeypatch.setattr(OpenAIClipEncoder, "__init__", fake_init)
    encoder = build_encoder("openai-clip:ViT-B/32", cache_dir="/tmp/x")

    assert isinstance(encoder, OpenAIClipEncoder)
    assert captured == {"variant": "ViT-B/32", "device": None, "download_root": "/tmp/x"}
    assert encoder.model_id == "openai-clip:ViT-B/32"


def test_build_encoder_resolves_open_clip(monkeypatch):
    captured: dict[str, object] = {}

    def fake_init(self, model_name, pretrained, device=None, cache_dir=None):
        captured["model_name"] = model_name
        captured["pretrained"] = pretrained
        captured["cache_dir"] = cache_dir
        self.model_id = f"open-clip:{model_name}/{pretrained}"
        self.embedding_dim = 768
        self.device = "cpu"

    monkeypatch.setattr(OpenClipEncoder, "__init__", fake_init)
    encoder = build_encoder("open-clip:ViT-L-14/dfn2b", cache_dir="/tmp/oc")

    assert isinstance(encoder, OpenClipEncoder)
    assert captured == {
        "model_name": "ViT-L-14",
        "pretrained": "dfn2b",
        "cache_dir": "/tmp/oc",
    }


def test_build_encoder_siglip_ignores_cache_dir(monkeypatch):
    """SigLIP uses HF's own cache and should silently ignore cache_dir."""
    captured: dict[str, object] = {}

    def fake_init(self, hf_id, device=None):
        captured["hf_id"] = hf_id
        self.model_id = f"siglip:{hf_id}"
        self.embedding_dim = 1024
        self.device = "cpu"

    monkeypatch.setattr(SiglipEncoder, "__init__", fake_init)
    encoder = build_encoder("siglip:google/siglip2-base", cache_dir="/tmp/ignored")

    assert isinstance(encoder, SiglipEncoder)
    assert captured == {"hf_id": "google/siglip2-base"}


def test_build_encoder_open_clip_requires_pretrained():
    with pytest.raises(ValueError, match="pretrained"):
        build_encoder("open-clip:ViT-L-14")


def test_build_encoder_resolves_siglip(monkeypatch):
    captured: dict[str, object] = {}

    def fake_init(self, hf_id, device=None):
        captured["hf_id"] = hf_id
        self.model_id = f"siglip:{hf_id}"
        self.embedding_dim = 1024
        self.device = "cpu"

    monkeypatch.setattr(SiglipEncoder, "__init__", fake_init)
    encoder = build_encoder("siglip:google/siglip2-large-patch16-256")

    assert isinstance(encoder, SiglipEncoder)
    assert captured == {"hf_id": "google/siglip2-large-patch16-256"}


def test_build_encoder_unknown_backend_raises():
    with pytest.raises(ValueError, match="Unknown encoder backend"):
        build_encoder("magic:foo")


def test_build_encoder_missing_model_raises():
    with pytest.raises(ValueError, match="missing a model identifier"):
        build_encoder("openai-clip")


def test_build_encoder_none_uses_default(monkeypatch):
    """A None spec must resolve to DEFAULT_ENCODER_SPEC, not error out.

    The default is now ``open-clip:ViT-L-14/dfn2b_s39b``, so the mock has
    to patch OpenClipEncoder rather than OpenAIClipEncoder.
    """
    monkeypatch.setattr(
        OpenClipEncoder,
        "__init__",
        lambda self, model_name, pretrained, device=None, cache_dir=None: setattr(
            self, "model_id", f"open-clip:{model_name}/{pretrained}"
        )
        or setattr(self, "embedding_dim", 1024)
        or setattr(self, "device", "cpu"),
    )
    encoder = build_encoder(None)
    assert encoder.model_id == DEFAULT_ENCODER_SPEC


def test_embedding_cache_mismatch_message():
    err = EmbeddingCacheMismatch("openai-clip:ViT-B/32", "siglip:foo", "/tmp/cache.npz")
    assert "openai-clip:ViT-B/32" in str(err)
    assert "siglip:foo" in str(err)
    assert "/tmp/cache.npz" in str(err)
    assert err.stored == "openai-clip:ViT-B/32"
    assert err.current == "siglip:foo"


def test_default_calibration_is_identity():
    """CLIP-style encoders should not transform raw cosines."""

    class _Stub(ImageTextEncoder):
        model_id = "stub:identity"
        embedding_dim = 4
        device = "cpu"

        def encode_images(self, images):
            raise NotImplementedError

        def encode_text(self, texts):
            raise NotImplementedError

    cosines = np.array([-0.3, 0.0, 0.25, 0.7], dtype=np.float32)
    out = _Stub().calibrate_similarity(cosines)
    np.testing.assert_array_equal(out, cosines)


def test_siglip_calibration_applies_learned_sigmoid(monkeypatch):
    """SigLIP must apply sigmoid(cos * exp(scale) + bias) to recover probabilities.

    The bug being guarded: raw SigLIP image-text cosines for matching pairs sit
    around 0.05-0.20, well below a CLIP-tuned threshold like 0.2, so search
    yielded zero hits. The learned scale/bias map them back into a CLIP-like
    range.
    """
    monkeypatch.setattr(
        SiglipEncoder,
        "__init__",
        lambda self, hf_id, device=None: (
            setattr(self, "model_id", f"siglip:{hf_id}"),
            setattr(self, "embedding_dim", 1024),
            setattr(self, "device", "cpu"),
            setattr(self, "_logit_scale", math.log(10.0)),  # exp(scale) == 10
            setattr(self, "_logit_bias", -2.0),
        )
        and None,
    )
    encoder = SiglipEncoder(hf_id="google/siglip2-large-patch16-256")

    cosines = np.array([0.0, 0.2, 0.5, 1.0], dtype=np.float64)
    expected = 1.0 / (1.0 + np.exp(-(cosines * 10.0 + -2.0)))
    np.testing.assert_allclose(encoder.calibrate_similarity(cosines), expected, atol=1e-7)

    # A SigLIP-typical match cosine of 0.10 was filtering out at threshold 0.2;
    # after calibration it lands above threshold.
    boosted = encoder.calibrate_similarity(np.array([0.10]))[0]
    assert boosted > 0.2, f"expected calibrated 0.10 cosine to clear 0.2 threshold, got {boosted}"


def test_siglip_calibration_no_op_when_scale_missing(monkeypatch):
    """Defensive: if the SigLIP model didn't expose logit_scale, fall back to identity."""
    monkeypatch.setattr(
        SiglipEncoder,
        "__init__",
        lambda self, hf_id, device=None: (
            setattr(self, "model_id", f"siglip:{hf_id}"),
            setattr(self, "embedding_dim", 1024),
            setattr(self, "device", "cpu"),
            setattr(self, "_logit_scale", None),
            setattr(self, "_logit_bias", 0.0),
        )
        and None,
    )
    encoder = SiglipEncoder(hf_id="x")
    cosines = np.array([0.1, 0.5])
    np.testing.assert_array_equal(encoder.calibrate_similarity(cosines), cosines)


def test_siglip_encode_text_uses_prompt_ensembling(monkeypatch):
    """SigLIP wraps each input in every template, encodes the batch, then
    mean-pools across templates. The result must collapse back to ``(n_texts, D)``.
    """
    import torch

    from photomap.backend.encoders import SIGLIP_PROMPT_TEMPLATES

    captured = {}

    class FakeProcessorOutput(dict):
        def to(self, device):
            return self

    class FakeProcessor:
        def __call__(self, *, text, **kwargs):
            captured["text"] = list(text)
            # Pretend each string tokenizes to a (B, L) input.
            return FakeProcessorOutput(
                input_ids=torch.zeros((len(text), 4), dtype=torch.long)
            )

    class FakeModel:
        # ``get_text_features`` returns deterministic embeddings: one row per
        # input string. Each row's first slot is the index of that input within
        # the (n_texts * n_templates) batch, so the test can confirm which
        # rows landed in which group after view+mean.
        def get_text_features(self, **kwargs):
            n = kwargs["input_ids"].shape[0]
            out = torch.zeros((n, 8), dtype=torch.float32)
            for i in range(n):
                out[i, 0] = float(i + 1)
            return out

    monkeypatch.setattr(
        SiglipEncoder,
        "__init__",
        lambda self, hf_id, device=None: (
            setattr(self, "model_id", f"siglip:{hf_id}"),
            setattr(self, "embedding_dim", 8),
            setattr(self, "device", "cpu"),
            setattr(self, "_logit_scale", None),
            setattr(self, "_logit_bias", 0.0),
            setattr(self, "_processor", FakeProcessor()),
            setattr(self, "_model", FakeModel()),
            setattr(self, "use_ensembling", True),
        )
        and None,
    )
    encoder = SiglipEncoder(hf_id="x")

    out = encoder.encode_text(["woman", "cat"])
    assert out.shape == (2, 8)

    # Templates were applied in input-major / template-minor order.
    expected_strings = [
        tpl.format(t) for t in ["woman", "cat"] for tpl in SIGLIP_PROMPT_TEMPLATES
    ]
    assert captured["text"] == expected_strings

    # Final embeddings must be unit length so they're comparable with the
    # stored image embeddings.
    norms = np.linalg.norm(out, axis=-1)
    np.testing.assert_allclose(norms, np.ones_like(norms), atol=1e-6)


def test_get_cached_encoder_reuses_instance(monkeypatch):
    """Repeated search queries must reuse the same encoder instance."""
    clear_encoder_cache()
    call_count = {"n": 0}

    def fake_build(spec=None, *, cache_dir=None, device=None):
        call_count["n"] += 1
        marker = object()
        return type(
            "FakeEncoder",
            (),
            {
                "model_id": spec,
                "embedding_dim": 4,
                "device": "cpu",
                "_marker": marker,
                "close": lambda self: None,
                "encode_images": lambda self, images: None,
                "encode_text": lambda self, texts: None,
                "calibrate_similarity": lambda self, cosines: cosines,
            },
        )()

    monkeypatch.setattr(encoders_module, "build_encoder", fake_build)

    a = get_cached_encoder("openai-clip:ViT-B/32", cache_dir="/tmp/x")
    b = get_cached_encoder("openai-clip:ViT-B/32", cache_dir="/tmp/x")
    assert a is b
    assert call_count["n"] == 1

    # Different spec -> different cached instance.
    c = get_cached_encoder("siglip:google/siglip2-base-patch16-224")
    assert c is not a
    assert call_count["n"] == 2

    clear_encoder_cache()
    d = get_cached_encoder("openai-clip:ViT-B/32", cache_dir="/tmp/x")
    assert d is not a
    assert call_count["n"] == 3
    clear_encoder_cache()
