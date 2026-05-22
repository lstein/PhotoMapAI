from base64 import b64encode
from pathlib import Path
from urllib.parse import quote

import pytest
from fixtures import (
    count_test_images,
    fetch_filename,
    poll_during_indexing,
)

TEST_IMAGE_COUNT = count_test_images()


def test_index_update(client, new_album):
    """Test the creation of an index for the given album."""
    from photomap.backend.embeddings import Embeddings

    # Start async index update
    response = client.post("/update_index_async", json={"album_key": new_album["key"]})
    assert response.status_code == 202
    task_id = response.json().get("task_id")
    assert task_id is not None
    try:
        poll_during_indexing(client, new_album["key"])
    except TimeoutError as e:
        pytest.fail(f"Indexing did not complete: {str(e)}")

    # test that the index exists
    response = client.get(f"/index_exists/{new_album['key']}")
    assert response.status_code == 200
    exists = response.json().get("exists")
    assert exists is True

    # Check that the embedding index contains 9 images
    response = client.get(f"/album/{new_album['key']}")
    assert response.status_code == 200
    embeddings_path = response.json().get("index")
    assert embeddings_path is not None
    embeddings = Embeddings.open_cached_embeddings(embeddings_path)
    assert embeddings is not None
    assert len(embeddings["filenames"]) == TEST_IMAGE_COUNT

    # Ask the API for the index metadata and ensure it matches the number of index files
    response = client.get(f"/index_metadata/{new_album['key']}")
    assert response.status_code == 200
    metadata = response.json()
    assert metadata["filename_count"] == len(embeddings["filenames"])
    assert (
        Path(metadata["embeddings_path"]).resolve().as_posix()
        == Path(embeddings_path).resolve().as_posix()
    )
    assert metadata["last_modified"] is not None


def test_index_exists(client, new_album):
    """Test the index_exists endpoint."""

    response = client.get(f"/index_exists/{new_album['key']}")
    assert response.status_code == 200
    exists = response.json().get("exists")
    assert exists is False  # Index should not exist before creation

    # Now create the index
    response = client.post("/update_index_async", json={"album_key": new_album["key"]})
    assert response.status_code == 202  # Index creation started
    try:
        poll_during_indexing(client, new_album["key"])
    except TimeoutError as e:
        pytest.fail(f"Indexing did not complete: {str(e)}")

    # now it should exist
    response = client.get(f"/index_exists/{new_album['key']}")
    assert response.status_code == 200
    exists = response.json().get("exists")
    assert exists is True  # Index should exist after creation

    # Now delete the album and check again
    response = client.delete(f"/delete_album/{new_album['key']}")
    assert response.status_code == 200

    response = client.get(f"/index_exists/{new_album['key']}")
    assert response.status_code == 404  # Index should not exist anymore
    assert response.json().get("exists", False) is False


def test_image_search(client, new_album):
    """Test the search functionality."""
    TEST_IMAGE_FILE = "./tests/backend/test_images/flower1.jpeg"
    TEST_TEXT_FILE = "./tests/backend/test_images/building1.jpeg"

    # Create the index first
    response = client.post("/update_index_async", json={"album_key": new_album["key"]})
    assert response.status_code == 202
    try:
        poll_during_indexing(client, new_album["key"])
    except TimeoutError as e:
        pytest.fail(f"Indexing did not complete: {str(e)}")

    # Now perform a search
    with open(TEST_IMAGE_FILE, "rb") as image_file:
        image_data = b64encode(image_file.read()).decode("utf-8")

    response = client.post(
        f"/search_with_text_and_image/{quote(new_album['key'])}",
        json={
            "image_data": image_data,
        },
    )
    assert response.status_code == 200
    slide_summary = response.json()
    assert slide_summary is not None
    assert slide_summary.get("results") is not None
    assert len(slide_summary["results"]) > 0
    filenames = [
        fetch_filename(client, new_album["key"], result["index"])
        for result in slide_summary["results"]
        if result["score"] > 0.6
    ]

    assert (
        Path(TEST_IMAGE_FILE).name in filenames
    ), "Image search did not return expected image"
    assert (
        Path(TEST_TEXT_FILE).name not in filenames
    ), "Image search returned unexpected image"


def test_text_search(client, new_album):
    """Test the search functionality."""
    TEST_POS_FILE = "./tests/test_images/flower1.jpeg"
    TEST_NEG_FILE = "./tests/test_images/building1.jpeg"

    # Create the index first
    response = client.post("/update_index_async", json={"album_key": new_album["key"]})
    assert response.status_code == 202
    try:
        poll_during_indexing(client, new_album["key"])
    except TimeoutError as e:
        pytest.fail(f"Indexing did not complete: {str(e)}")

    # Now perform a search
    response = client.post(
        f"/search_with_text_and_image/{quote(new_album['key'])}",
        json={
            "positive_query": "flower",
            "negative_query": "building",
            "negative_weight": 0.1,
            "positive_weight": 0.9,
        },
    )
    assert response.status_code == 200
    slide_summary = response.json()
    assert slide_summary is not None
    assert slide_summary.get("results") is not None
    assert len(slide_summary["results"]) > 0
    filenames = [
        fetch_filename(client, new_album["key"], result["index"])
        for result in slide_summary["results"]
        if result["score"] > 0.25
    ]
    assert (
        Path(TEST_POS_FILE).name in filenames
    ), "Text search did not return expected image"
    assert (
        Path(TEST_NEG_FILE).name not in filenames
    ), "Text search returned unexpected image"


def test_image_indices_lookup(client, new_album):
    """The batch /image_indices endpoint resolves album basenames to their
    indices and returns null for filenames not present in the album. Powers
    the metadata drawer's reference-image-thumbnail enhancement.
    """
    response = client.post("/update_index_async", json={"album_key": new_album["key"]})
    assert response.status_code == 202
    try:
        poll_during_indexing(client, new_album["key"])
    except TimeoutError as e:
        pytest.fail(f"Indexing did not complete: {str(e)}")

    known = fetch_filename(client, new_album["key"], 0)
    response = client.post(
        f"/image_indices/{quote(new_album['key'])}",
        json={"filenames": [known, "definitely-not-in-album.png", "another-missing.jpg"]},
    )
    assert response.status_code == 200
    indices = response.json()["indices"]
    assert indices[known] == 0
    assert indices["definitely-not-in-album.png"] is None
    assert indices["another-missing.jpg"] is None


def test_image_indices_empty_request(client, new_album):
    """An empty filenames list returns an empty mapping (not an error)."""
    response = client.post("/update_index_async", json={"album_key": new_album["key"]})
    assert response.status_code == 202
    try:
        poll_during_indexing(client, new_album["key"])
    except TimeoutError as e:
        pytest.fail(f"Indexing did not complete: {str(e)}")

    response = client.post(
        f"/image_indices/{quote(new_album['key'])}",
        json={"filenames": []},
    )
    assert response.status_code == 200
    assert response.json() == {"indices": {}}


def test_image_indices_unknown_album(client):
    """Unknown album keys yield a 404 rather than an empty success."""
    response = client.post(
        "/image_indices/nonexistent_album",
        json={"filenames": ["any.png"]},
    )
    assert response.status_code == 404


def test_calibration_skipped_for_image_queries(tmp_path, monkeypatch):
    """SigLIP's sigmoid calibration was crushing every image-image cosine to
    1.0, returning 100 saturated matches. Calibration must only apply to
    text-only queries.
    """
    import numpy as np
    from PIL import Image

    from photomap.backend import encoders as encoders_module
    from photomap.backend.embeddings import Embeddings

    # Build a tiny .npz with three known embeddings so the search code has
    # something to score against.
    embed_dim = 4
    stored = np.array(
        [
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
        ],
        dtype=np.float32,
    )
    npz_path = tmp_path / "stub.npz"
    np.savez(
        npz_path,
        embeddings=stored,
        filenames=np.array(["a.jpg", "b.jpg", "c.jpg"]),
        modification_times=np.array([1.0, 2.0, 3.0]),
        metadata=np.array([{}, {}, {}], dtype=object),
        model_id=np.array("stub:test"),
        embedding_dim=np.array(embed_dim),
    )

    class StubEncoder:
        model_id = "stub:test"
        embedding_dim = embed_dim
        device = "cpu"
        calibrate_calls = 0

        def encode_images(self, images):
            return stored[:1]  # closest to "a.jpg"

        def encode_text(self, texts):
            return stored[:1]

        def calibrate_similarity(self, cosines):
            type(self).calibrate_calls += 1
            # Detectable transform: negate so we can prove it ran or didn't.
            return -cosines

        def close(self):
            pass

    encoders_module.clear_encoder_cache()
    monkeypatch.setattr(encoders_module, "build_encoder", lambda *a, **k: StubEncoder())

    emb = Embeddings(embeddings_path=npz_path, encoder_spec="stub:test")

    # Pure-image query: calibration must NOT run.
    StubEncoder.calibrate_calls = 0
    indices, scores = emb.search_images_by_text_and_image(
        query_image_data=Image.new("RGB", (8, 8), color="red"),
        positive_query=None,
        image_weight=1.0,
        positive_weight=0.0,
        top_k=3,
        minimum_score=0.0,
    )
    assert StubEncoder.calibrate_calls == 0, "image-only query must not trigger calibration"
    assert all(s >= 0 for s in scores), "raw cosines should not have been negated"

    # Pure-text query: calibration MUST run.
    StubEncoder.calibrate_calls = 0
    emb.search_images_by_text_and_image(
        query_image_data=None,
        positive_query="anything",
        image_weight=0.0,
        positive_weight=1.0,
        top_k=3,
        minimum_score=-1.0,  # let everything through so we can inspect scores
    )
    assert StubEncoder.calibrate_calls == 1, "text-only query must apply calibration"

    encoders_module.clear_encoder_cache()


def test_search_use_query_optimization_sets_encoder_flag(tmp_path, monkeypatch):
    """The search method must propagate use_query_optimization to the cached
    encoder's ``use_ensembling`` attribute before encoding text. The frontend
    sources this value from the album's per-album toggle.
    """
    import numpy as np

    from photomap.backend import encoders as encoders_module
    from photomap.backend.embeddings import Embeddings

    embed_dim = 4
    npz_path = tmp_path / "stub.npz"
    np.savez(
        npz_path,
        embeddings=np.eye(2, embed_dim, dtype=np.float32),
        filenames=np.array(["a.jpg", "b.jpg"]),
        modification_times=np.array([1.0, 2.0]),
        metadata=np.array([{}, {}], dtype=object),
        model_id=np.array("stub:test"),
        embedding_dim=np.array(embed_dim),
    )

    class StubEncoder:
        model_id = "stub:test"
        embedding_dim = embed_dim
        device = "cpu"
        use_ensembling = True  # the encoder ships with this attribute

        def encode_images(self, images):
            return np.zeros((1, embed_dim), dtype=np.float32)

        def encode_text(self, texts):
            return np.array([[0.0, 1.0, 0.0, 0.0]], dtype=np.float32)

        def calibrate_similarity(self, cosines):
            return cosines

        def close(self):
            pass

    encoders_module.clear_encoder_cache()
    monkeypatch.setattr(encoders_module, "build_encoder", lambda *a, **k: StubEncoder())
    emb = Embeddings(embeddings_path=npz_path, encoder_spec="stub:test")

    # use_query_optimization=False must turn the encoder's flag off.
    emb.search_images_by_text_and_image(
        positive_query="anything",
        image_weight=0.0,
        positive_weight=1.0,
        top_k=2,
        minimum_score=-1.0,
        use_query_optimization=False,
    )
    cached = next(iter(encoders_module._search_encoder_cache.values()))
    assert cached.use_ensembling is False

    # And turning it back on must flip the flag again.
    emb.search_images_by_text_and_image(
        positive_query="anything",
        image_weight=0.0,
        positive_weight=1.0,
        top_k=2,
        minimum_score=-1.0,
        use_query_optimization=True,
    )
    assert cached.use_ensembling is True

    # ``None`` means "leave it alone" — the encoder's current state stays.
    cached.use_ensembling = False
    emb.search_images_by_text_and_image(
        positive_query="anything",
        image_weight=0.0,
        positive_weight=1.0,
        top_k=2,
        minimum_score=-1.0,
        use_query_optimization=None,
    )
    assert cached.use_ensembling is False

    encoders_module.clear_encoder_cache()


def test_search_combines_modalities_in_score_space(tmp_path, monkeypatch):
    """Mixed-modality and negative queries combine cosines in score space:
    weighted average over positive (image + positive-text) contributions,
    minus the negative contribution. Text cosines are calibrated so they
    sit on a comparable scale to image cosines (a no-op for CLIP, sigmoid
    for SigLIP). This test uses a stub encoder whose calibrate halves text
    cosines — a detectable transform that would also flip score ordering
    between the new (score-space) and old (embedding-space) implementations.
    """
    import numpy as np
    from PIL import Image

    from photomap.backend import encoders as encoders_module
    from photomap.backend.embeddings import Embeddings

    embed_dim = 4
    # Stored embeddings, each aligned with one basis direction.
    stored = np.array(
        [
            [1.0, 0.0, 0.0, 0.0],  # img_match  — only the image query points here
            [0.0, 1.0, 0.0, 0.0],  # pos_match  — only the positive-text query points here
            [0.0, 0.0, 1.0, 0.0],  # neg_match  — only the negative-text query points here
            [0.0, 0.0, 0.0, 1.0],  # nothing    — control
        ],
        dtype=np.float32,
    )
    npz_path = tmp_path / "stub.npz"
    np.savez(
        npz_path,
        embeddings=stored,
        filenames=np.array(["img.jpg", "pos.jpg", "neg.jpg", "none.jpg"]),
        modification_times=np.array([1.0, 2.0, 3.0, 4.0]),
        metadata=np.array([{}, {}, {}, {}], dtype=object),
        model_id=np.array("stub:test"),
        embedding_dim=np.array(embed_dim),
    )

    class StubEncoder:
        model_id = "stub:test"
        embedding_dim = embed_dim
        device = "cpu"

        def encode_images(self, images):
            return np.array([[1.0, 0.0, 0.0, 0.0]], dtype=np.float32)

        def encode_text(self, texts):
            # Dispatch on input so positive vs negative produce distinct directions.
            out = np.zeros((len(texts), embed_dim), dtype=np.float32)
            for i, t in enumerate(texts):
                out[i] = (
                    [0.0, 0.0, 1.0, 0.0]
                    if "neg" in t.lower()
                    else [0.0, 1.0, 0.0, 0.0]
                )
            return out

        def calibrate_similarity(self, cosines):
            # Halve text cosines — detectable, monotonic, doesn't break ordering.
            return cosines * 0.5

        def close(self):
            pass

    encoders_module.clear_encoder_cache()
    monkeypatch.setattr(encoders_module, "build_encoder", lambda *a, **k: StubEncoder())

    emb = Embeddings(embeddings_path=npz_path, encoder_spec="stub:test")
    sorted_filenames = ["img.jpg", "pos.jpg", "neg.jpg", "none.jpg"]

    def scores_by_filename(indices, scores):
        return {sorted_filenames[i]: s for i, s in zip(indices, scores, strict=False)}

    # 50/50 image+positive query, no negative.
    # Expected: positive_score = (image_w*cos_img + pos_w*calibrate(cos_pos)) / (image_w + pos_w)
    #   For img.jpg:  (0.5*1.0 + 0.5*0.5*0.0) / 1.0 = 0.5
    #   For pos.jpg:  (0.5*0.0 + 0.5*0.5*1.0) / 1.0 = 0.25
    #   For neg.jpg:  0.0
    #   For none.jpg: 0.0
    # The new weighting is honest about image dominance (raw 1.0 > calibrated 0.5);
    # the OLD embedding-space combine would have produced (cos_img + cos_pos)/sqrt(2) ≈ 0.707
    # for both img.jpg and pos.jpg — a tied score that hid the modality scale gap.
    indices, scores = emb.search_images_by_text_and_image(
        query_image_data=Image.new("RGB", (8, 8), color="red"),
        positive_query="positive query",
        image_weight=0.5,
        positive_weight=0.5,
        top_k=4,
        minimum_score=-1.0,
    )
    by_name = scores_by_filename(indices, scores)
    assert by_name["img.jpg"] == pytest.approx(0.5, abs=1e-6)
    assert by_name["pos.jpg"] == pytest.approx(0.25, abs=1e-6)
    assert by_name["neg.jpg"] == pytest.approx(0.0, abs=1e-6)

    # Positive + negative query, no image.
    #   positive_score = calibrate(cos_pos) = 0.5 * cos_pos
    #   final = positive_score - neg_w * calibrate(cos_neg)
    # For pos.jpg:  0.5*1.0 - 0.5 * 0.5*0.0 = 0.5
    # For neg.jpg:  0.5*0.0 - 0.5 * 0.5*1.0 = -0.25
    # For img.jpg:  0
    indices, scores = emb.search_images_by_text_and_image(
        query_image_data=None,
        positive_query="positive query",
        negative_query="negative thing",
        image_weight=0.0,
        positive_weight=1.0,
        negative_weight=0.5,
        top_k=4,
        minimum_score=-1.0,
    )
    by_name = scores_by_filename(indices, scores)
    assert by_name["pos.jpg"] == pytest.approx(0.5, abs=1e-6)
    assert by_name["neg.jpg"] == pytest.approx(-0.25, abs=1e-6)
    assert by_name["img.jpg"] == pytest.approx(0.0, abs=1e-6)

    encoders_module.clear_encoder_cache()
