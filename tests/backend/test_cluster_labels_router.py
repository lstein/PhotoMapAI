"""Tests for the /cluster_labels/{album_key} endpoint.

These tests mock the compute layer at the boundary so they're fast (no CLIP
weights loaded). A real-encoder smoke test belongs in checkpoint 6.
"""


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
