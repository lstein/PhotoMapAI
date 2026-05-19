"""Unit tests for the vocab embedding cache (cluster_labels module).

The cluster-label endpoint tests live separately and will be added once the
router lands. These tests use a mock encoder to keep them fast and
hermetic — no CLIP weights are loaded.
"""

from pathlib import Path

import numpy as np
import pytest

from photomap.backend import cluster_labels


class FakeEncoder:
    """Deterministic stand-in for an ImageTextEncoder.

    Produces L2-normalized embeddings derived from a hash of the input text.
    Stable across runs, fast, no GPU.
    """

    embedding_dim = 16

    def __init__(self, spec: str):
        self.model_id = spec
        self.encode_calls = 0
        self.last_batch_size = 0

    def encode_text(self, texts: list[str]) -> np.ndarray:
        self.encode_calls += 1
        self.last_batch_size = len(texts)
        rows = []
        for t in texts:
            rng = np.random.default_rng(abs(hash(t)) % (2**32))
            v = rng.standard_normal(self.embedding_dim).astype(np.float32)
            v /= np.linalg.norm(v)
            rows.append(v)
        return np.stack(rows)


@pytest.fixture
def fake_encoder(monkeypatch):
    """Replace get_cached_encoder with a fake; return the active instance."""
    instances: dict[str, FakeEncoder] = {}

    def _factory(spec, *, cache_dir=None, device=None):
        if spec not in instances:
            instances[spec] = FakeEncoder(spec)
        return instances[spec]

    monkeypatch.setattr(cluster_labels, "get_cached_encoder", _factory)
    return instances


@pytest.fixture
def tiny_vocab(tmp_path, monkeypatch):
    """Point cluster_labels at a 5-phrase vocab file under tmp_path."""
    vocab = tmp_path / "vocab.txt"
    vocab.write_text(
        "# A header comment\n"
        "abbey\n"
        "airport terminal\n"
        "\n"
        "# Another comment\n"
        "wedding\n"
        "abbey\n"  # duplicate — should be deduped
        "mountain\n"
        "lake\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(cluster_labels, "vocab_file_path", lambda: vocab)
    return vocab


@pytest.fixture
def isolated_cache(tmp_path, monkeypatch):
    """Reroute vocab_cache_path under tmp_path so tests don't touch the real cache."""
    base = tmp_path / "cache" / "cluster_vocab"

    def _path(spec):
        return base / f"{cluster_labels._sanitize_spec(spec)}.npz"

    monkeypatch.setattr(cluster_labels, "vocab_cache_path", _path)
    return base


def test_load_vocab_phrases_strips_comments_and_dedupes(tiny_vocab):
    phrases = cluster_labels.load_vocab_phrases()
    assert phrases == ["abbey", "airport terminal", "wedding", "mountain", "lake"]


def test_load_vocab_phrases_lowercases():
    p = Path(__file__).parent / "fixtures_vocab.txt"
    p.write_text("UPPERCASE\nMixedCase Phrase\n", encoding="utf-8")
    try:
        out = cluster_labels.load_vocab_phrases(p)
        assert out == ["uppercase", "mixedcase phrase"]
    finally:
        p.unlink()


def test_vocab_cache_path_sanitizes():
    p1 = cluster_labels.vocab_cache_path("open-clip:ViT-L-14/dfn2b_s39b")
    p2 = cluster_labels.vocab_cache_path("openai-clip:ViT-B/32")
    assert "/" not in p1.name and ":" not in p1.name
    assert "/" not in p2.name and ":" not in p2.name
    assert p1.name != p2.name


def test_build_caches_and_reuses(tiny_vocab, isolated_cache, fake_encoder):
    spec = "fake:test-encoder"
    phrases1, emb1 = cluster_labels.get_or_build_vocab_embeddings(spec)
    assert phrases1 == ["abbey", "airport terminal", "wedding", "mountain", "lake"]
    assert emb1.shape == (5, FakeEncoder.embedding_dim)
    assert emb1.dtype == np.float32
    # Each row L2-normalized
    np.testing.assert_allclose(np.linalg.norm(emb1, axis=1), 1.0, rtol=1e-5)
    # Encoder was called once with the expected batch shape (5 phrases × 7 templates)
    encoder = fake_encoder[spec]
    assert encoder.encode_calls == 1
    assert encoder.last_batch_size == 5 * len(cluster_labels.PROMPT_TEMPLATES)

    # Second call returns the cache without invoking the encoder again.
    phrases2, emb2 = cluster_labels.get_or_build_vocab_embeddings(spec)
    assert phrases2 == phrases1
    np.testing.assert_array_equal(emb2, emb1)
    assert encoder.encode_calls == 1  # unchanged — cache hit


def test_cache_invalidates_on_vocab_edit(tiny_vocab, isolated_cache, fake_encoder):
    spec = "fake:test-encoder"
    cluster_labels.get_or_build_vocab_embeddings(spec)
    encoder = fake_encoder[spec]
    assert encoder.encode_calls == 1

    # Edit the vocab — bump the mtime forward
    import os
    import time
    tiny_vocab.write_text(tiny_vocab.read_text() + "\nstadium\n", encoding="utf-8")
    future = time.time() + 5
    os.utime(tiny_vocab, (future, future))

    phrases, emb = cluster_labels.get_or_build_vocab_embeddings(spec)
    assert "stadium" in phrases
    assert emb.shape[0] == len(phrases)
    assert encoder.encode_calls == 2  # rebuilt


def test_cache_invalidates_on_encoder_spec_mismatch(
    tiny_vocab, isolated_cache, fake_encoder, monkeypatch
):
    """If two specs sanitize to the same filename (hypothetical), the stamp catches it."""
    spec = "fake:enc-a"
    cluster_labels.get_or_build_vocab_embeddings(spec)

    # Directly hack the cached file's stamp to look like a different encoder
    cache_path = cluster_labels.vocab_cache_path(spec)
    data = dict(np.load(cache_path, allow_pickle=False))
    data["encoder_spec"] = np.array("fake:enc-different")
    np.savez(cache_path, **data)

    encoder = fake_encoder[spec]
    calls_before = encoder.encode_calls
    cluster_labels.get_or_build_vocab_embeddings(spec)
    assert encoder.encode_calls == calls_before + 1  # rebuild triggered


def test_cache_invalidates_on_template_count_change(
    tiny_vocab, isolated_cache, fake_encoder, monkeypatch
):
    spec = "fake:enc-templates"
    cluster_labels.get_or_build_vocab_embeddings(spec)
    encoder = fake_encoder[spec]
    assert encoder.encode_calls == 1

    # Pretend PROMPT_TEMPLATES grew without changing the vocab file
    monkeypatch.setattr(
        cluster_labels,
        "PROMPT_TEMPLATES",
        cluster_labels.PROMPT_TEMPLATES + ("a different template of {}",),
    )
    cluster_labels.get_or_build_vocab_embeddings(spec)
    assert encoder.encode_calls == 2  # rebuilt with new template count


def test_empty_vocab(tmp_path, isolated_cache, fake_encoder, monkeypatch):
    vocab = tmp_path / "empty.txt"
    vocab.write_text("# only comments\n# another comment\n", encoding="utf-8")
    monkeypatch.setattr(cluster_labels, "vocab_file_path", lambda: vocab)
    phrases, emb = cluster_labels.get_or_build_vocab_embeddings("fake:empty")
    assert phrases == []
    assert emb.shape == (0, FakeEncoder.embedding_dim)
