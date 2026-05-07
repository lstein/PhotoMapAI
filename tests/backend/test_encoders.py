"""Unit tests for the pluggable encoder layer.

These tests deliberately avoid loading model weights so they run fast in CI.
End-to-end indexing/search tests live elsewhere and exercise the default
``openai-clip:ViT-B/32`` backend.
"""

from __future__ import annotations

import pytest

from photomap.backend.encoders import (
    DEFAULT_ENCODER_SPEC,
    EmbeddingCacheMismatch,
    OpenAIClipEncoder,
    OpenClipEncoder,
    SiglipEncoder,
    build_encoder,
)


def test_default_spec_is_legacy_clip():
    assert DEFAULT_ENCODER_SPEC == "openai-clip:ViT-B/32"


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
    encoder = build_encoder("openai-clip:ViT-B/32", download_root="/tmp/x")

    assert isinstance(encoder, OpenAIClipEncoder)
    assert captured == {"variant": "ViT-B/32", "device": None, "download_root": "/tmp/x"}
    assert encoder.model_id == "openai-clip:ViT-B/32"


def test_build_encoder_resolves_open_clip(monkeypatch):
    captured: dict[str, object] = {}

    def fake_init(self, model_name, pretrained, device=None, cache_dir=None):
        captured["model_name"] = model_name
        captured["pretrained"] = pretrained
        self.model_id = f"open-clip:{model_name}/{pretrained}"
        self.embedding_dim = 768
        self.device = "cpu"

    monkeypatch.setattr(OpenClipEncoder, "__init__", fake_init)
    encoder = build_encoder("open-clip:ViT-L-14/dfn2b")

    assert isinstance(encoder, OpenClipEncoder)
    assert captured == {"model_name": "ViT-L-14", "pretrained": "dfn2b"}


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
    """A None spec should resolve to the legacy default, not error out."""
    monkeypatch.setattr(
        OpenAIClipEncoder,
        "__init__",
        lambda self, variant, device=None, download_root=None: setattr(
            self, "model_id", f"openai-clip:{variant}"
        )
        or setattr(self, "embedding_dim", 512)
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
