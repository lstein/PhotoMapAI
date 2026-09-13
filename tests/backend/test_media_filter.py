"""The images/videos filter on the backend.

Two pieces: ``/media_indices`` tells the frontend which album entries are
videos (browsing is sequenced client-side, so the classification has to be
known before a slide is chosen), and ``media_filter`` on the search request
restricts candidates *before* ``top_k`` so a filtered search still fills its
result quota.
"""

import numpy as np
from fixtures import build_index, requires_ffmpeg

from photomap.backend.embeddings import media_filter_mask

FILENAMES = ["/a/one.jpg", "/a/two.mp4", "/a/three.png", "/a/four.mov"]


def test_mask_is_none_when_nothing_is_filtered():
    assert media_filter_mask(FILENAMES, "both") is None
    # Fail open: an unknown value must not hide the album.
    assert media_filter_mask(FILENAMES, "audio") is None


def test_mask_keeps_the_requested_media_type():
    assert media_filter_mask(FILENAMES, "videos").tolist() == [False, True, False, True]
    assert media_filter_mask(FILENAMES, "images").tolist() == [True, False, True, False]


def test_mask_accepts_numpy_string_arrays():
    mask = media_filter_mask(np.array(FILENAMES), "videos")
    assert mask.dtype == bool
    assert mask.tolist() == [False, True, False, True]


def test_media_indices_lists_videos_in_sorted_order(client, mixed_album):
    # The fixture sorts the video to index 0 and the photo to index 1.
    response = client.get(f"/media_indices/{mixed_album['key']}")
    assert response.status_code == 200
    assert response.json() == {"total": 2, "video_indices": [0]}


def test_media_indices_404s_without_an_index(client, new_album):
    response = client.get(f"/media_indices/{new_album['key']}")
    assert response.status_code == 404


def _media_types(client, album_key, indices):
    types = set()
    for index in indices:
        path = client.get(f"/image_path/{album_key}/{index}").text
        types.add("video" if path.lower().endswith((".mp4", ".mov", ".mkv", ".webm", ".avi")) else "image")
    return types


@requires_ffmpeg
def test_search_honours_the_media_filter(client, new_media_album):
    build_index(client, new_media_album)
    key = new_media_album["key"]
    # A permissive floor so the media type, not the score, decides the result.
    base = {"positive_query": "a picture", "min_search_score": -1.0, "max_search_results": 100}

    everything = client.post(f"/search_with_text_and_image/{key}", json=base).json()["results"]
    all_indices = [r["index"] for r in everything]
    assert _media_types(client, key, all_indices) == {"image", "video"}

    videos = client.post(
        f"/search_with_text_and_image/{key}", json={**base, "media_filter": "videos"}
    ).json()["results"]
    video_indices = [r["index"] for r in videos]
    assert video_indices
    assert _media_types(client, key, video_indices) == {"video"}

    images = client.post(
        f"/search_with_text_and_image/{key}", json={**base, "media_filter": "images"}
    ).json()["results"]
    image_indices = [r["index"] for r in images]
    assert _media_types(client, key, image_indices) == {"image"}

    # Filtering happens before top_k: the two halves partition the whole.
    assert sorted(video_indices + image_indices) == sorted(all_indices)


@requires_ffmpeg
def test_filtered_search_fills_its_quota(client, new_media_album):
    # With top_k smaller than the number of images, an unfiltered top_k could
    # be all photos; "videos" must still return up to top_k videos rather than
    # the videos that happened to survive an unfiltered cut.
    build_index(client, new_media_album)
    key = new_media_album["key"]
    total_videos = client.get(f"/media_indices/{key}").json()["video_indices"]
    assert total_videos

    response = client.post(
        f"/search_with_text_and_image/{key}",
        json={
            "positive_query": "a picture",
            "min_search_score": -1.0,
            "max_search_results": 1,
            "media_filter": "videos",
        },
    )
    results = response.json()["results"]
    assert len(results) == 1
    assert results[0]["index"] in total_videos


def test_search_rejects_an_unknown_media_filter(client, mixed_album):
    response = client.post(
        f"/search_with_text_and_image/{mixed_album['key']}",
        json={"positive_query": "x", "media_filter": "audio"},
    )
    assert response.status_code == 422
