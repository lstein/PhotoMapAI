"""Tests for the /cluster_labels/{album_key} endpoint.

These tests mock the compute layer at the boundary so they're fast (no CLIP
weights loaded). A real-encoder smoke test belongs in checkpoint 6.
"""

import pytest


def test_endpoint_returns_labels_dict(client, new_album, monkeypatch):
    fake_labels = {
        0: {"label": "abbey", "alternates": ["wedding", "kitchen"], "score": 0.27},
        1: {"label": "mountain", "alternates": ["forest", "valley"], "score": 0.19},
    }

    captured_call = {}

    def fake_get_or_build(embeddings, *, cluster_eps, cluster_min_samples, top_k):
        captured_call["eps"] = cluster_eps
        captured_call["ms"] = cluster_min_samples
        captured_call["top_k"] = top_k
        captured_call["album_index"] = str(embeddings.embeddings_path)
        return fake_labels

    monkeypatch.setattr(
        "photomap.backend.routers.cluster_labels.get_or_build_cluster_labels",
        fake_get_or_build,
    )

    response = client.get(f"/cluster_labels/{new_album['key']}")
    assert response.status_code == 200
    body = response.json()
    assert "labels" in body
    # Int cluster IDs become string JSON keys
    assert set(body["labels"].keys()) == {"0", "1"}
    assert body["labels"]["0"] == {
        "label": "abbey",
        "alternates": ["wedding", "kitchen"],
        "score": 0.27,
    }
    # Defaults match the umap router so cluster IDs align
    assert captured_call["eps"] == 0.07
    assert captured_call["ms"] == 10
    assert captured_call["top_k"] == 3
    assert captured_call["album_index"].endswith("embeddings.npz")


def test_endpoint_forwards_query_params(client, new_album, monkeypatch):
    captured = {}

    def fake_get_or_build(embeddings, *, cluster_eps, cluster_min_samples, top_k):
        captured["eps"] = cluster_eps
        captured["ms"] = cluster_min_samples
        captured["top_k"] = top_k
        return {}

    monkeypatch.setattr(
        "photomap.backend.routers.cluster_labels.get_or_build_cluster_labels",
        fake_get_or_build,
    )

    response = client.get(
        f"/cluster_labels/{new_album['key']}"
        "?cluster_eps=0.2&cluster_min_samples=15&top_k=5"
    )
    assert response.status_code == 200
    assert captured == {"eps": 0.2, "ms": 15, "top_k": 5}


def test_endpoint_handles_empty_result(client, new_album, monkeypatch):
    monkeypatch.setattr(
        "photomap.backend.routers.cluster_labels.get_or_build_cluster_labels",
        lambda embeddings, **kw: {},
    )
    response = client.get(f"/cluster_labels/{new_album['key']}")
    assert response.status_code == 200
    assert response.json() == {"labels": {}}


def test_endpoint_404_for_missing_album(client):
    response = client.get("/cluster_labels/does_not_exist")
    assert response.status_code == 404


def test_image_label_endpoint_returns_label(client, new_album, monkeypatch):
    monkeypatch.setattr(
        "photomap.backend.routers.cluster_labels.compute_image_label",
        lambda emb, idx, *, top_k: {"label": "vase", "alternates": ["jar"], "score": 0.42},
    )
    response = client.get(f"/image_label/{new_album['key']}/7")
    assert response.status_code == 200
    assert response.json() == {"label": "vase", "alternates": ["jar"], "score": 0.42}


def test_image_label_endpoint_empty_when_no_label(client, new_album, monkeypatch):
    monkeypatch.setattr(
        "photomap.backend.routers.cluster_labels.compute_image_label",
        lambda emb, idx, *, top_k: {},
    )
    response = client.get(f"/image_label/{new_album['key']}/0")
    assert response.status_code == 200
    assert response.json() == {}


def test_image_label_endpoint_404_for_missing_album(client):
    response = client.get("/image_label/does_not_exist/0")
    assert response.status_code == 404


@pytest.mark.slow
def test_endpoint_smoke_with_real_encoder(client, new_album, monkeypatch, tmp_path, capsys):
    """End-to-end smoke test: real CLIP encoder, real vocab, real cluster labels.

    Slow (~30-60s cold locally; several minutes on CI with cold CLIP download
    and CPU-only inference). Marked ``slow`` so CI excludes it via
    ``pytest -m 'not slow'``; run locally before pushing real-encoder changes.
    Isolates the vocab embedding cache to tmp_path so a regression in vocab
    building isn't masked by a prior cache. Album weights themselves use the
    standard CLIP cache so we don't redownload them.
    """
    from fixtures import build_index

    from photomap.backend import cluster_labels

    # Isolate vocab cache so each run actually exercises the build path.
    isolated = tmp_path / "vocab_cache"

    def _isolated_path(spec):
        return isolated / f"{cluster_labels._sanitize_spec(spec)}.npz"

    monkeypatch.setattr(cluster_labels, "vocab_cache_path", _isolated_path)

    build_index(client, new_album, monkeypatch)

    # Relax DBSCAN to ensure at least one cluster forms over the 9 test images
    # (defaults of min_samples=10 would put everything in noise with n=9).
    response = client.get(
        f"/cluster_labels/{new_album['key']}?cluster_eps=5&cluster_min_samples=2"
    )
    assert response.status_code == 200
    body = response.json()
    assert "labels" in body
    labels = body["labels"]
    assert len(labels) >= 1, "expected at least one cluster from the 9 themed test images"

    vocab_phrases = set(cluster_labels.load_vocab_phrases())
    for cid, info in labels.items():
        assert isinstance(cid, str)
        assert info["label"] in vocab_phrases, f"cluster {cid} label {info['label']!r} not in vocab"
        assert -1.0 <= info["score"] <= 1.0
        for alt in info["alternates"]:
            assert alt in vocab_phrases

    # Surface the result so a human running this test sees what the labeler picked.
    with capsys.disabled():
        print(f"\nSmoke test produced {len(labels)} cluster(s):")
        for cid in sorted(labels.keys(), key=int):
            info = labels[cid]
            alts = ", ".join(info["alternates"]) or "—"
            print(f"  cluster {cid}: {info['label']!r}  score={info['score']:.3f}  alts=[{alts}]")
