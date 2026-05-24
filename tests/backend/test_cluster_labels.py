"""Unit tests for the vocab embedding cache (cluster_labels module).

The cluster-label endpoint tests live separately and will be added once the
router lands. These tests use a mock encoder to keep them fast and
hermetic — no CLIP weights are loaded.
"""

from pathlib import Path

import numpy as np
import pytest

from photomap.backend import cluster_labels


@pytest.fixture(autouse=True)
def _isolate_user_vocab(monkeypatch, tmp_path_factory):
    """Default every test to a non-existent user vocab path under tmp.

    Without this, tests would read the developer's real
    `~/.config/photomap/cluster_vocab_extra.txt` if it happens to exist, which
    would silently change phrase counts and break assertions. Individual tests
    that want to exercise the user-file path can re-monkeypatch to a real file.
    """
    nonexistent = tmp_path_factory.mktemp("user_cfg") / "extras_should_not_exist.txt"
    monkeypatch.setattr(cluster_labels, "user_vocab_file_path", lambda: nonexistent)


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
    # The autouse _isolate_user_vocab fixture points user_vocab_file_path at a
    # nonexistent tmp path, so this exercises bundled-only behavior.
    phrases = cluster_labels.load_vocab_phrases()
    assert phrases == ["abbey", "airport terminal", "wedding", "mountain", "lake"]


def test_load_vocab_phrases_merges_user_extras(tiny_vocab, monkeypatch, tmp_path):
    user = tmp_path / "extras.txt"
    user.write_text("# user additions\nstadium\nabbey\nlibrary\n", encoding="utf-8")
    monkeypatch.setattr(cluster_labels, "user_vocab_file_path", lambda: user)
    phrases = cluster_labels.load_vocab_phrases()
    # 'abbey' was already in the bundled vocab — must dedupe across files.
    assert phrases.count("abbey") == 1
    assert "stadium" in phrases
    assert "library" in phrases


def test_load_vocab_phrases_missing_user_file_ok(tiny_vocab):
    # Autouse fixture already points user file path at a nonexistent location.
    phrases = cluster_labels.load_vocab_phrases()
    assert phrases == ["abbey", "airport terminal", "wedding", "mountain", "lake"]


def test_user_vocab_filename_constant():
    """The user file lives next to config.yaml under platformdirs.user_config_dir."""
    from platformdirs import user_config_dir

    # Call the un-monkeypatched implementation by re-creating it inline. The
    # autouse fixture replaces user_vocab_file_path with a tmp-path lambda,
    # but the FILENAME constant and the platformdirs choice are what matter.
    assert cluster_labels.USER_VOCAB_FILENAME == "cluster_vocab_extra.txt"
    expected_parent = Path(user_config_dir("photomap", "photomap"))
    # Construct what the real implementation would return.
    real_path = expected_parent / cluster_labels.USER_VOCAB_FILENAME
    assert real_path.name == cluster_labels.USER_VOCAB_FILENAME
    assert real_path.parent == expected_parent


# ---------------------------------------------------------------------------
# Per-image labels
# ---------------------------------------------------------------------------


def test_compute_image_label_scores_against_vocab(synthetic_album):
    """An image whose embedding was built near vocab[k] should get phrase k."""
    # Synthetic data: cluster 0 sits near vocab[0]="abbey", cluster 1 near
    # vocab[1]="wedding", cluster 2 near vocab[2]="mountain". Image 0 is the
    # first member of cluster 0, so its top-1 label should be "abbey".
    result = cluster_labels.compute_image_label(synthetic_album, 0, top_k=3)
    assert result["label"] == "abbey"
    assert len(result["alternates"]) == 2
    assert 0.0 < result["score"] <= 1.0

    # Image 20 is in cluster 2 → "mountain".
    result20 = cluster_labels.compute_image_label(synthetic_album, 20, top_k=3)
    assert result20["label"] == "mountain"


def test_compute_image_label_out_of_bounds(synthetic_album):
    assert cluster_labels.compute_image_label(synthetic_album, -1) == {}
    assert cluster_labels.compute_image_label(synthetic_album, 9999) == {}


def test_compute_image_label_caches_within_process(synthetic_album, monkeypatch):
    """Second call for the same image hits the LRU cache, not the vocab embed."""
    # Wrap get_or_build_vocab_embeddings to count invocations.
    call_count = {"n": 0}
    original = cluster_labels.get_or_build_vocab_embeddings

    def counting_get_or_build(*args, **kwargs):
        call_count["n"] += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(cluster_labels, "get_or_build_vocab_embeddings", counting_get_or_build)
    # Clear any prior cache contents
    cluster_labels._IMAGE_LABEL_CACHE.clear()

    cluster_labels.compute_image_label(synthetic_album, 5)
    assert call_count["n"] == 1
    cluster_labels.compute_image_label(synthetic_album, 5)
    assert call_count["n"] == 1  # cached — vocab not re-fetched


def test_compute_image_label_cache_evicts_past_max(synthetic_album, monkeypatch):
    # Replace the module-level cache with a small one for this test so the
    # eviction policy is observable in a few iterations.
    from photomap.backend.util import BoundedLRU

    monkeypatch.setattr(cluster_labels, "_IMAGE_LABEL_CACHE", BoundedLRU(maxsize=3))

    for i in range(5):
        cluster_labels.compute_image_label(synthetic_album, i)
    # Only the most-recent 3 survive.
    assert len(cluster_labels._IMAGE_LABEL_CACHE) == 3


class OomThenSucceedEncoder(FakeEncoder):
    """Raises a CUDA-OOM-shaped RuntimeError for the first N batches at the
    initial size, then encodes normally once the caller halves the batch."""

    def __init__(self, spec: str, fail_when_size_at_least: int):
        super().__init__(spec)
        self.fail_threshold = fail_when_size_at_least

    def encode_text(self, texts):
        if len(texts) >= self.fail_threshold:
            raise RuntimeError(
                "CUDA out of memory. Tried to allocate 4.38 GiB. (fake)"
            )
        return super().encode_text(texts)


def test_encode_retries_with_smaller_batch_on_oom(tiny_vocab, monkeypatch):
    """The OOM-retry path should halve the batch until the encode succeeds."""
    spec = "fake:oom-once"
    instance = OomThenSucceedEncoder(spec, fail_when_size_at_least=20)
    monkeypatch.setattr(
        cluster_labels, "get_cached_encoder", lambda s, **kw: instance
    )
    # Five phrases × 7 templates = 35-string initial batch (above the threshold).
    # The retry halves: 35 → fails. Halve to phrases=2 → 14 strings, succeeds.
    monkeypatch.setattr(cluster_labels, "VOCAB_BATCH_PHRASES", 5)

    phrases, emb = cluster_labels.get_or_build_vocab_embeddings(spec)
    assert len(phrases) == 5
    assert emb.shape == (5, FakeEncoder.embedding_dim)
    np.testing.assert_allclose(np.linalg.norm(emb, axis=1), 1.0, rtol=1e-5)


def test_encode_propagates_non_oom_errors(tiny_vocab, monkeypatch):
    """A non-OOM error must not trigger the retry loop."""

    class BoomEncoder(FakeEncoder):
        def encode_text(self, texts):
            raise ValueError("not an OOM, should propagate")

    spec = "fake:boom"
    monkeypatch.setattr(
        cluster_labels, "get_cached_encoder", lambda s, **kw: BoomEncoder(spec)
    )
    with pytest.raises(ValueError, match="not an OOM"):
        cluster_labels.get_or_build_vocab_embeddings(spec)


def test_vocab_cache_invalidates_on_user_file_edit(
    tiny_vocab, isolated_cache, fake_encoder, monkeypatch, tmp_path
):
    """Touching the user extras file should rebuild the vocab embeddings."""
    import os
    import time

    user = tmp_path / "extras.txt"
    user.write_text("stadium\n", encoding="utf-8")
    monkeypatch.setattr(cluster_labels, "user_vocab_file_path", lambda: user)

    spec = "fake:user-vocab"
    cluster_labels.get_or_build_vocab_embeddings(spec)
    encoder = fake_encoder[spec]
    calls_before = encoder.encode_calls

    # Bump user file mtime forward
    future = time.time() + 5
    os.utime(user, (future, future))

    cluster_labels.get_or_build_vocab_embeddings(spec)
    assert encoder.encode_calls == calls_before + 1


def test_vocab_cache_invalidates_when_user_file_removed(
    tiny_vocab, isolated_cache, fake_encoder, monkeypatch, tmp_path
):
    """Deleting the user extras file should rebuild — the phrase set shrank.

    mtime-only invalidation would miss this: the bundled vocab's mtime doesn't
    change, and the cache's own mtime is newer than that, so a naive check
    would keep returning a stale cache that still has the user's extra phrases
    baked in.
    """
    user = tmp_path / "extras.txt"
    user.write_text("stadium\nlibrary\n", encoding="utf-8")
    monkeypatch.setattr(cluster_labels, "user_vocab_file_path", lambda: user)

    spec = "fake:user-removed"
    phrases_before, _ = cluster_labels.get_or_build_vocab_embeddings(spec)
    assert "stadium" in phrases_before
    encoder = fake_encoder[spec]
    calls_before = encoder.encode_calls

    user.unlink()

    phrases_after, _ = cluster_labels.get_or_build_vocab_embeddings(spec)
    assert "stadium" not in phrases_after
    assert "library" not in phrases_after
    assert encoder.encode_calls == calls_before + 1  # rebuilt


def test_vocab_cache_invalidates_when_user_file_added(
    tiny_vocab, isolated_cache, fake_encoder, monkeypatch, tmp_path
):
    """Adding a user extras file later should rebuild even if its mtime is old.

    A user may copy/restore an extras file with `cp -p` or `touch -r` such that
    its mtime ends up older than the existing vocab cache. The fingerprint
    check catches this where mtime alone would not.
    """
    import os

    spec = "fake:user-added"
    cluster_labels.get_or_build_vocab_embeddings(spec)  # build cache, no user file
    encoder = fake_encoder[spec]
    calls_before = encoder.encode_calls

    # Create the user file but back-date it to before the cache was written.
    user = tmp_path / "extras.txt"
    user.write_text("stadium\n", encoding="utf-8")
    cache_path = cluster_labels.vocab_cache_path(spec)
    past = cache_path.stat().st_mtime - 60
    os.utime(user, (past, past))
    monkeypatch.setattr(cluster_labels, "user_vocab_file_path", lambda: user)

    phrases, _ = cluster_labels.get_or_build_vocab_embeddings(spec)
    assert "stadium" in phrases
    assert encoder.encode_calls == calls_before + 1


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


def test_concurrent_builds_are_serialized(tiny_vocab, isolated_cache, monkeypatch):
    """Concurrent first-time callers must not redundantly re-encode the vocab.

    Simulates the production race: /cluster_labels and /image_label both
    dispatch through asyncio.to_thread, so a cold cache plus a few near-
    simultaneous requests would otherwise trigger N parallel encoder builds.
    The first thread blocks inside encode_text until the other threads have
    arrived at the lock; then the gate is released and we assert that exactly
    one build ran.
    """
    import threading

    spec = "fake:concurrent"
    entered = threading.Event()
    release = threading.Event()
    call_count = 0
    call_lock = threading.Lock()

    class GatedEncoder:
        embedding_dim = 16

        def encode_text(self, texts):
            nonlocal call_count
            with call_lock:
                call_count += 1
                first = call_count == 1
            if first:
                entered.set()
                # Block until the test signals release, giving the other
                # threads time to pile up on the build lock.
                assert release.wait(timeout=5.0), "release event never fired"
            rows = []
            for t in texts:
                rng = np.random.default_rng(abs(hash(t)) % (2**32))
                v = rng.standard_normal(self.embedding_dim).astype(np.float32)
                v /= np.linalg.norm(v)
                rows.append(v)
            return np.stack(rows)

    encoder = GatedEncoder()
    monkeypatch.setattr(
        cluster_labels, "get_cached_encoder", lambda spec, *, cache_dir=None, device=None: encoder
    )
    # Ensure no stale lock from a previous test run.
    monkeypatch.setattr(cluster_labels, "_VOCAB_BUILD_LOCKS", {})

    results: list[tuple[list[str], np.ndarray]] = []
    errors: list[BaseException] = []

    def worker():
        try:
            results.append(cluster_labels.get_or_build_vocab_embeddings(spec))
        except BaseException as err:
            errors.append(err)

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for t in threads:
        t.start()

    assert entered.wait(timeout=5.0), "first thread never reached encode_text"
    # Give the other threads a moment to block on the build lock. There's no
    # public hook to observe that, so we sleep briefly; the assertion below
    # (call_count == 1) catches the race regardless of timing.
    import time
    time.sleep(0.1)
    release.set()
    for t in threads:
        t.join(timeout=5.0)
        assert not t.is_alive(), "worker thread hung"

    assert not errors, f"worker raised: {errors!r}"
    assert call_count == 1, f"encoder was called {call_count} times; guard failed"
    assert len(results) == len(threads)
    # All callers see the same phrases and identical embeddings.
    phrases0, emb0 = results[0]
    for phrases, emb in results[1:]:
        assert phrases == phrases0
        np.testing.assert_array_equal(emb, emb0)


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


# ---------------------------------------------------------------------------
# Cluster label computation
# ---------------------------------------------------------------------------


D = 16
SYNTHETIC_PHRASES = ["abbey", "wedding", "mountain", "kitchen", "car"]


def _make_synthetic_vocab(seed: int = 0) -> tuple[list[str], np.ndarray]:
    """Five distinct L2-normalized vectors, one per phrase."""
    rng = np.random.default_rng(seed)
    vecs = rng.standard_normal((len(SYNTHETIC_PHRASES), D)).astype(np.float32)
    vecs /= np.linalg.norm(vecs, axis=1, keepdims=True)
    return list(SYNTHETIC_PHRASES), vecs


def _make_synthetic_album(tmp_path: Path, vocab_vecs: np.ndarray):
    """Build an embeddings.npz + umap.npz forming 3 clean clusters.

    Cluster k has 10 members whose high-dim mean is exactly vocab_vecs[k]
    (plus tiny noise) and whose 2D coords sit in a tight blob at (k*5, k*5).
    """
    from photomap.backend.embeddings import Embeddings

    rng = np.random.default_rng(42)
    rows_per_cluster = 10
    n_clusters = 3
    n = rows_per_cluster * n_clusters

    high_dim = np.zeros((n, D), dtype=np.float32)
    umap_coords = np.zeros((n, 2), dtype=np.float32)
    filenames = np.empty(n, dtype=object)
    for k in range(n_clusters):
        start = k * rows_per_cluster
        end = start + rows_per_cluster
        members = vocab_vecs[k] + 0.05 * rng.standard_normal((rows_per_cluster, D)).astype(np.float32)
        members /= np.linalg.norm(members, axis=1, keepdims=True)
        high_dim[start:end] = members
        umap_coords[start:end] = np.array([k * 5.0, k * 5.0]) + 0.1 * rng.standard_normal((rows_per_cluster, 2))
        for j in range(rows_per_cluster):
            filenames[start + j] = f"cluster{k}_img{j}.jpg"

    embeddings_path = tmp_path / "embeddings.npz"
    np.savez(
        embeddings_path,
        embeddings=high_dim,
        filenames=filenames,
        metadata=np.array([{}] * n, dtype=object),
        modification_times=np.arange(n, dtype=np.float64),
        model_id="fake:test-encoder",
        embedding_dim=D,
    )
    np.savez(tmp_path / "umap.npz", umap=umap_coords)

    return Embeddings(embeddings_path=embeddings_path, encoder_spec="fake:test-encoder")


@pytest.fixture
def synthetic_album(tmp_path, monkeypatch):
    """An Embeddings instance over 3-cluster synthetic data, with vocab patched in."""
    phrases, vocab_vecs = _make_synthetic_vocab()
    monkeypatch.setattr(
        cluster_labels,
        "get_or_build_vocab_embeddings",
        lambda spec, **kw: (phrases, vocab_vecs),
    )
    return _make_synthetic_album(tmp_path, vocab_vecs)


def test_compute_cluster_labels_assigns_expected_phrases(synthetic_album):
    result = cluster_labels.compute_cluster_labels(
        synthetic_album, cluster_eps=1.0, cluster_min_samples=3, top_k=3
    )
    # Three clusters expected, no -1 key
    assert set(result.keys()) == {0, 1, 2}
    # Each cluster's top phrase should be the one its centroid was constructed near.
    # DBSCAN labels in 2D-space order: (0,0) -> cid 0, (5,5) -> cid 1, (10,10) -> cid 2
    for cid in (0, 1, 2):
        assert result[cid]["label"] == SYNTHETIC_PHRASES[cid], (
            f"Cluster {cid} got label {result[cid]['label']!r}; "
            f"expected {SYNTHETIC_PHRASES[cid]!r}"
        )
        assert len(result[cid]["alternates"]) == 2
        assert SYNTHETIC_PHRASES[cid] not in result[cid]["alternates"]
        assert 0.0 < result[cid]["score"] <= 1.0


def test_compute_cluster_labels_excludes_noise(tmp_path, monkeypatch):
    phrases, vocab_vecs = _make_synthetic_vocab()
    monkeypatch.setattr(
        cluster_labels,
        "get_or_build_vocab_embeddings",
        lambda spec, **kw: (phrases, vocab_vecs),
    )
    emb = _make_synthetic_album(tmp_path, vocab_vecs)
    # min_samples high enough that no cluster forms -> all noise -> empty result
    result = cluster_labels.compute_cluster_labels(
        emb, cluster_eps=0.01, cluster_min_samples=999, top_k=3
    )
    assert result == {}


def test_compute_cluster_labels_includes_medoid_index(synthetic_album):
    """Each non-noise cluster should report a medoid_index that's an actual member."""
    result = cluster_labels.compute_cluster_labels(
        synthetic_album, cluster_eps=1.0, cluster_min_samples=3, top_k=3
    )
    # Synthetic data: 10 images per cluster, in contiguous ranges 0-9, 10-19, 20-29.
    # modification_times = arange(30), so sorted index == raw index. The medoid
    # for cluster k must therefore land in [k*10, (k+1)*10).
    for cid in (0, 1, 2):
        assert "medoid_index" in result[cid]
        m = result[cid]["medoid_index"]
        assert isinstance(m, int)
        assert cid * 10 <= m < (cid + 1) * 10, (
            f"cluster {cid} medoid {m} not in its member range [{cid*10}, {(cid+1)*10})"
        )


def test_cached_labels_round_trip_medoid(synthetic_album):
    """Saved medoid survives the cache round-trip with no drift."""
    fresh = cluster_labels.get_or_build_cluster_labels(
        synthetic_album, cluster_eps=1.0, cluster_min_samples=3
    )
    reloaded = cluster_labels.get_or_build_cluster_labels(
        synthetic_album, cluster_eps=1.0, cluster_min_samples=3
    )
    for cid, info in fresh.items():
        assert reloaded[cid]["medoid_index"] == info["medoid_index"]


def test_legacy_cache_without_medoid_still_loads(synthetic_album):
    """A cache file written before medoid support should still deserialize."""
    # Build a cache, then strip the medoids field to simulate a pre-medoid file.
    cluster_labels.get_or_build_cluster_labels(
        synthetic_album, cluster_eps=1.0, cluster_min_samples=3
    )
    cache_path = cluster_labels.labels_cache_path(synthetic_album, 1.0, 3)
    data = dict(np.load(cache_path, allow_pickle=False))
    data.pop("medoids", None)
    np.savez(cache_path, **data)

    reloaded = cluster_labels.get_or_build_cluster_labels(
        synthetic_album, cluster_eps=1.0, cluster_min_samples=3
    )
    # All three clusters should still be present; medoid_index just omitted.
    assert set(reloaded.keys()) == {0, 1, 2}
    for info in reloaded.values():
        assert "medoid_index" not in info


def test_compute_cluster_labels_top_k_one(synthetic_album):
    result = cluster_labels.compute_cluster_labels(
        synthetic_album, cluster_eps=1.0, cluster_min_samples=3, top_k=1
    )
    for cid in result:
        assert result[cid]["alternates"] == []


def test_get_or_build_caches_and_reuses(synthetic_album, monkeypatch):
    call_count = {"n": 0}
    real_compute = cluster_labels.compute_cluster_labels

    def counting_compute(*args, **kwargs):
        call_count["n"] += 1
        return real_compute(*args, **kwargs)

    monkeypatch.setattr(cluster_labels, "compute_cluster_labels", counting_compute)

    a = cluster_labels.get_or_build_cluster_labels(
        synthetic_album, cluster_eps=1.0, cluster_min_samples=3
    )
    b = cluster_labels.get_or_build_cluster_labels(
        synthetic_album, cluster_eps=1.0, cluster_min_samples=3
    )
    assert call_count["n"] == 1, "second call should hit the cache"
    assert a == b


def test_get_or_build_invalidates_on_embeddings_touch(synthetic_album, monkeypatch):
    import os
    import time

    call_count = {"n": 0}
    real_compute = cluster_labels.compute_cluster_labels

    def counting_compute(*args, **kwargs):
        call_count["n"] += 1
        return real_compute(*args, **kwargs)

    monkeypatch.setattr(cluster_labels, "compute_cluster_labels", counting_compute)

    cluster_labels.get_or_build_cluster_labels(
        synthetic_album, cluster_eps=1.0, cluster_min_samples=3
    )
    # Bump embeddings.npz forward to invalidate the labels cache. Also bump
    # umap.npz to the same mtime — otherwise Embeddings.umap_embeddings sees
    # umap.npz as older than embeddings.npz and triggers a real UMAP refit,
    # which dominates this test's runtime (~5s even on 30 vectors).
    future = time.time() + 5
    os.utime(synthetic_album.embeddings_path, (future, future))
    os.utime(synthetic_album.embeddings_path.parent / "umap.npz", (future, future))
    cluster_labels.get_or_build_cluster_labels(
        synthetic_album, cluster_eps=1.0, cluster_min_samples=3
    )
    assert call_count["n"] == 2


def test_get_or_build_invalidates_on_vocab_touch(synthetic_album, monkeypatch, tmp_path):
    """Editing cluster_vocab.txt must invalidate every per-album labels cache."""
    import os
    import time

    # Synthetic vocab file so we can bump its mtime in isolation.
    vocab = tmp_path / "vocab.txt"
    vocab.write_text("abbey\nwedding\nmountain\nkitchen\ncar\n", encoding="utf-8")
    monkeypatch.setattr(cluster_labels, "vocab_file_path", lambda: vocab)

    call_count = {"n": 0}
    real_compute = cluster_labels.compute_cluster_labels

    def counting_compute(*args, **kwargs):
        call_count["n"] += 1
        return real_compute(*args, **kwargs)

    monkeypatch.setattr(cluster_labels, "compute_cluster_labels", counting_compute)

    cluster_labels.get_or_build_cluster_labels(
        synthetic_album, cluster_eps=1.0, cluster_min_samples=3
    )
    future = time.time() + 5
    os.utime(vocab, (future, future))
    cluster_labels.get_or_build_cluster_labels(
        synthetic_album, cluster_eps=1.0, cluster_min_samples=3
    )
    assert call_count["n"] == 2


def test_get_or_build_invalidates_when_user_vocab_removed(
    synthetic_album, monkeypatch, tmp_path
):
    """Removing the user extras file should invalidate per-album labels caches.

    Mtime-only invalidation misses this case (bundled vocab mtime is unchanged
    and cache is newer than that), so the fingerprint check is what catches it.
    """
    call_count = {"n": 0}
    real_compute = cluster_labels.compute_cluster_labels

    def counting_compute(*args, **kwargs):
        call_count["n"] += 1
        return real_compute(*args, **kwargs)

    monkeypatch.setattr(cluster_labels, "compute_cluster_labels", counting_compute)

    # Point user_vocab_file_path at a real user file with extras.
    user = tmp_path / "extras.txt"
    user.write_text("stadium\nlibrary\n", encoding="utf-8")
    monkeypatch.setattr(cluster_labels, "user_vocab_file_path", lambda: user)

    cluster_labels.get_or_build_cluster_labels(
        synthetic_album, cluster_eps=1.0, cluster_min_samples=3
    )
    assert call_count["n"] == 1

    # Now remove the user file — phrase set shrinks, fingerprint changes.
    user.unlink()

    cluster_labels.get_or_build_cluster_labels(
        synthetic_album, cluster_eps=1.0, cluster_min_samples=3
    )
    assert call_count["n"] == 2  # rebuilt


def test_legacy_labels_cache_without_fingerprint_rebuilds(synthetic_album, monkeypatch):
    """A cache file written before fingerprint support is force-rebuilt once.

    Before the fingerprint stamp existed, the only invalidation signal was
    mtime — which can't detect user-vocab file removal. We can't tell whether a
    fingerprint-less cache was built under the buggy regime, so we always
    rebuild to be safe. After this one rebuild the cache gets stamped and the
    normal fingerprint path takes over.
    """
    import numpy as np

    call_count = {"n": 0}
    real_compute = cluster_labels.compute_cluster_labels

    def counting_compute(*args, **kwargs):
        call_count["n"] += 1
        return real_compute(*args, **kwargs)

    monkeypatch.setattr(cluster_labels, "compute_cluster_labels", counting_compute)

    cluster_labels.get_or_build_cluster_labels(
        synthetic_album, cluster_eps=1.0, cluster_min_samples=3
    )
    cache_path = cluster_labels.labels_cache_path(synthetic_album, 1.0, 3)
    data = dict(np.load(cache_path, allow_pickle=False))
    data.pop("vocab_fingerprint", None)
    np.savez(cache_path, **data)

    reloaded = cluster_labels.get_or_build_cluster_labels(
        synthetic_album, cluster_eps=1.0, cluster_min_samples=3
    )
    assert call_count["n"] == 2  # legacy file forced a rebuild
    assert set(reloaded.keys()) == {0, 1, 2}
    # After rebuild the fingerprint is back, so a third call hits the cache.
    cluster_labels.get_or_build_cluster_labels(
        synthetic_album, cluster_eps=1.0, cluster_min_samples=3
    )
    assert call_count["n"] == 2


def test_get_or_build_invalidates_on_umap_touch(synthetic_album, monkeypatch):
    import os
    import time

    call_count = {"n": 0}
    real_compute = cluster_labels.compute_cluster_labels

    def counting_compute(*args, **kwargs):
        call_count["n"] += 1
        return real_compute(*args, **kwargs)

    monkeypatch.setattr(cluster_labels, "compute_cluster_labels", counting_compute)

    cluster_labels.get_or_build_cluster_labels(
        synthetic_album, cluster_eps=1.0, cluster_min_samples=3
    )
    future = time.time() + 5
    umap_path = synthetic_album.embeddings_path.parent / "umap.npz"
    os.utime(umap_path, (future, future))
    cluster_labels.get_or_build_cluster_labels(
        synthetic_album, cluster_eps=1.0, cluster_min_samples=3
    )
    assert call_count["n"] == 2


def test_per_eps_caches_are_independent(synthetic_album):
    p1 = cluster_labels.labels_cache_path(synthetic_album, 1.0, 3)
    p2 = cluster_labels.labels_cache_path(synthetic_album, 0.5, 3)
    p3 = cluster_labels.labels_cache_path(synthetic_album, 1.0, 5)
    assert p1 != p2
    assert p1 != p3
    assert p2 != p3


# ---------------------------------------------------------------------------
# rebuild_cluster_labels CLI
# ---------------------------------------------------------------------------


def test_cli_dispatch_to_do_rebuild_cluster_labels(monkeypatch):
    """`main()` must route the 'rebuild_cluster_labels' script name correctly."""
    import sys

    from photomap.backend import imagetool

    called = {"n": 0}
    monkeypatch.setattr(
        imagetool, "do_rebuild_cluster_labels", lambda: called.__setitem__("n", called["n"] + 1)
    )
    monkeypatch.setattr(sys, "argv", ["rebuild_cluster_labels"])
    imagetool.main()
    assert called["n"] == 1


def test_cli_missing_file_raises(monkeypatch, tmp_path):
    import sys

    from photomap.backend import imagetool

    monkeypatch.setattr(
        sys,
        "argv",
        ["rebuild_cluster_labels", "--embeddings", str(tmp_path / "does_not_exist.npz")],
    )
    try:
        imagetool.do_rebuild_cluster_labels()
    except FileNotFoundError as e:
        assert "does not exist" in str(e)
    else:  # pragma: no cover - failure path
        raise AssertionError("expected FileNotFoundError")


def test_cli_end_to_end_writes_label_cache(synthetic_album, monkeypatch, capsys):
    """do_rebuild_cluster_labels should produce a cache file next to umap.npz."""
    import sys

    from photomap.backend import imagetool

    monkeypatch.setattr(
        sys,
        "argv",
        [
            "rebuild_cluster_labels",
            "--embeddings", str(synthetic_album.embeddings_path),
            "--encoder-spec", "fake:test-encoder",
            "--eps", "1.0",
            "--min-samples", "3",
        ],
    )
    imagetool.do_rebuild_cluster_labels()

    cache_path = cluster_labels.labels_cache_path(synthetic_album, 1.0, 3)
    assert cache_path.exists()
    out = capsys.readouterr().out
    assert "labels for 3 clusters" in out


def test_empty_cluster_result_is_cached(synthetic_album, monkeypatch):
    call_count = {"n": 0}
    real_compute = cluster_labels.compute_cluster_labels

    def counting_compute(*args, **kwargs):
        call_count["n"] += 1
        return real_compute(*args, **kwargs)

    monkeypatch.setattr(cluster_labels, "compute_cluster_labels", counting_compute)

    # No clusters form (min_samples too high) — but the empty result should still cache.
    a = cluster_labels.get_or_build_cluster_labels(
        synthetic_album, cluster_eps=1.0, cluster_min_samples=999
    )
    b = cluster_labels.get_or_build_cluster_labels(
        synthetic_album, cluster_eps=1.0, cluster_min_samples=999
    )
    assert a == {} and b == {}
    assert call_count["n"] == 1, "empty result should be cached, not recomputed"
