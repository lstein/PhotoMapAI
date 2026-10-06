"""Sending videos to InvokeAI 7's video recall API.

Covers the record → request translation, ``POST /invokeai/video/recall``
(Recall / Remix), ``POST /invokeai/video/use_media`` (Initial Video / Ref
Video), and the ``video_recall`` capability flag. The upstream backend is an
``httpx.MockTransport``, so the multipart upload is really encoded.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import httpx
import pytest
from fixtures import media_fixture_path

from photomap.backend.config import get_config_manager
from photomap.backend.metadata_extraction import MetadataExtractor
from photomap.backend.metadata_modules.invoke.video_recall import (
    build_video_recall_payload,
    is_recallable_video_record,
)
from photomap.backend.routers import invoke as invoke_module
from photomap.backend.video import VIDEO_METADATA_KEY

BASE = "http://localhost:9090"
UUID_NAME = "4c1e7a52-0b1f-4f3a-9d2e-5a6b7c8d9e0f.mp4"


def _mi(name: str, **extra) -> dict:
    return {"key": f"key-{name}", "hash": "blake3:0", "name": name, "base": "wan", "type": "main", **extra}


WAN_RECORD = {
    "metadata_version": "1.0.0",
    "app_version": "7.0.0",
    "generation_mode": "wan_extend_video",
    "positive_prompt": "a heron lands",
    "negative_prompt": "blurry",
    "seed": 42,
    "steps": 30,
    "cfg_scale": 5.0,
    "width": 832,
    "height": 480,
    "num_frames": 81,
    "fps": 16,
    "model": _mi("Wan 2.2 I2V A14B"),
    "vae": _mi("Wan VAE"),
    "guidance_scale_low_noise": 3.5,  # pre-1.0 spelling
    "wan_t5_encoder": _mi("UMT5-XXL"),  # pre-1.0 spelling
    "loras": [
        {"model": _mi("Lightning"), "weight": 0.85},
        {"model": {"hash": "no name or key"}, "weight": 1.0},
    ],
    "source_video": {"video_name": "src.mp4"},
    "source_video_start_frame": 0,
    "source_video_end_frame": 40,
    "media_origin": "graph",
}

H3_RECORD = {
    "metadata_version": "1.0.0",
    "generation_mode": "minimax_h3_ref2v",
    "positive_prompt": "a dancer",
    "seed": 7,
    "num_frames": 97,
    "fps": 24,
    "model": _mi("MiniMax H3 Ref2VA", base="minimax-h3"),
    "minimax_h3_hybrid_base_model": _mi("H3 FL2VA", base="minimax-h3"),
    "minimax_h3_hybrid_start_block": 20,
    "minimax_h3_references": [
        {"kind": "video", "video_name": "dance.mp4", "conditioning": "video", "start_frame": 3},
        {"kind": "image", "image_name": "face.png", "detail": "max", "junk": 1},
        {"kind": "audio", "audio_name": "nope.wav"},
    ],
}

LTX_RECORD = {
    "metadata_version": "1.0.0",
    "generation_mode": "ltx2_t2v",
    "num_frames": 121,
    "positive_prompt": "rain on a window",
    "model": _mi("LTX-2.5", base="ltx2"),
    "ltx2_text_encoder_model": _mi("Gemma 4", base="any"),
    "ltx2_stg_scale": 1.0,
    "ltx2_conditioning_video": {"video_name": "beat.mp4"},
    "ltx2_conditioning_role": "audio",
}


# ── Record → request ──────────────────────────────────────────────────


class TestBuildPayload:
    def test_wan_record(self):
        payload = build_video_recall_payload(WAN_RECORD)
        assert payload == {
            "positive_prompt": "a heron lands",
            "negative_prompt": "blurry",
            "seed": 42,
            "steps": 30,
            "cfg_scale": 5.0,
            "width": 832,
            "height": 480,
            "num_frames": 81,
            "fps": 16,
            "model": "Wan 2.2 I2V A14B",
            "vae": "Wan VAE",
            "wan_guidance_scale_low_noise": 3.5,
            "wan_t5_encoder_model": "UMT5-XXL",
            "loras": [{"model_name": "Lightning", "weight": 0.85}],
            "source_video": {"video_name": "src.mp4"},
            "source_video_start_frame": 0,
            "source_video_end_frame": 40,
        }

    def test_does_not_mutate_the_record(self):
        record = json.loads(json.dumps(WAN_RECORD))
        build_video_recall_payload(record)
        assert record == WAN_RECORD

    def test_h3_references_are_filtered_and_trims_kept_whole(self):
        payload = build_video_recall_payload(H3_RECORD)
        assert payload["minimax_h3_references"] == [
            # A lone start_frame would 422 the whole request upstream.
            {"kind": "video", "video_name": "dance.mp4", "conditioning": "video"},
            {"kind": "image", "image_name": "face.png", "detail": "max"},
        ]
        assert payload["minimax_h3_hybrid_base_model"] == "H3 FL2VA"
        assert payload["minimax_h3_hybrid_start_block"] == 20
        # H3 records have no negative prompt; strict mode resets it upstream.
        assert "negative_prompt" not in payload

    def test_ltx_fields_pass_through(self):
        payload = build_video_recall_payload(LTX_RECORD)
        assert payload["ltx2_conditioning_video"] == {"video_name": "beat.mp4"}
        assert payload["ltx2_conditioning_role"] == "audio"
        assert payload["ltx2_text_encoder_model"] == "Gemma 4"
        assert payload["ltx2_stg_scale"] == 1.0

    def test_orphan_pairs_are_dropped(self):
        record = {
            **LTX_RECORD,
            "ltx2_conditioning_role": None,
            "source_video_start_frame": 5,
        }
        payload = build_video_recall_payload(record)
        assert "ltx2_conditioning_video" not in payload
        assert "source_video_start_frame" not in payload

    def test_record_only_keys_never_reach_the_request(self):
        payload = build_video_recall_payload({**WAN_RECORD, "photomap_video": {"fps": 16}})
        for key in ("generation_mode", "metadata_version", "app_version", "media_origin", "photomap_video"):
            assert key not in payload

    def test_explicit_null_negative_prompt_is_kept(self):
        payload = build_video_recall_payload({**WAN_RECORD, "negative_prompt": None})
        assert "negative_prompt" in payload and payload["negative_prompt"] is None

    def test_values_the_request_would_refuse_are_dropped_one_by_one(self):
        """InvokeAI 422s the whole request over one bad value, so each is
        dropped on its own and the rest still recalls."""
        record = {
            **WAN_RECORD,
            "fps": 23.976,  # not an int
            "cfg_scale": 0.5,  # below 1
            "steps": True,  # a bool is not a step count
            "seed": -1,
            "source_video_start_frame": 50,  # reversed trim
            "source_video_end_frame": 10,
            "vae": _mi("v" * 256),  # name too long
            "loras": [
                {"model": _mi("Too strong"), "weight": 11},
                {"model": _mi("Fine"), "weight": -2},
            ],
        }
        payload = build_video_recall_payload(record)
        for dropped in ("fps", "cfg_scale", "steps", "seed", "vae", "source_video_start_frame", "source_video_end_frame"):
            assert dropped not in payload, dropped
        assert payload["source_video"] == {"video_name": "src.mp4"}
        assert payload["loras"] == [{"model_name": "Fine", "weight": -2}]
        assert payload["model"] == "Wan 2.2 I2V A14B"
        assert payload["num_frames"] == 81

    def test_integral_float_frame_rate_is_sent_as_int(self):
        assert build_video_recall_payload({**WAN_RECORD, "fps": 16.0})["fps"] == 16

    def test_reference_qualifiers_outside_the_request_vocabulary_are_dropped(self):
        record = {
            **H3_RECORD,
            "minimax_h3_references": [
                {"kind": "image", "image_name": "a.png", "detail": "high"},
                {"kind": "video", "video_name": "b.mp4", "conditioning": "both", "start_frame": 9, "end_frame": 2},
            ],
        }
        assert build_video_recall_payload(record)["minimax_h3_references"] == [
            {"kind": "image", "image_name": "a.png"},
            {"kind": "video", "video_name": "b.mp4"},
        ]

    def test_reference_counts_are_capped_per_kind(self):
        videos = [{"kind": "video", "video_name": f"v{i}.mp4"} for i in range(5)]
        images = [{"kind": "image", "image_name": f"i{i}.png"} for i in range(12)]
        refs = build_video_recall_payload({**H3_RECORD, "minimax_h3_references": videos + images})[
            "minimax_h3_references"
        ]
        assert sum(r["kind"] == "video" for r in refs) == 3
        assert sum(r["kind"] == "image" for r in refs) == 9

    def test_unknown_conditioning_role_drops_the_pair(self):
        payload = build_video_recall_payload({**LTX_RECORD, "ltx2_conditioning_role": "both"})
        assert "ltx2_conditioning_video" not in payload
        assert "ltx2_conditioning_role" not in payload

    def test_generation_mode_alone_marks_a_video(self):
        record = {"generation_mode": "wan_t2v", "model": _mi("Wan"), "positive_prompt": "x"}
        assert is_recallable_video_record(record)

    def test_recallable_detection(self):
        assert is_recallable_video_record(WAN_RECORD)
        assert is_recallable_video_record(H3_RECORD)
        assert not is_recallable_video_record({})
        assert not is_recallable_video_record({"Make": "Pixel"})
        image_record = {"app_version": "5.0.0", "positive_prompt": "x", "seed": 1, "model": _mi("SDXL")}
        assert not is_recallable_video_record(image_record)

    def test_the_fixture_video_is_recallable(self):
        record = MetadataExtractor.extract_video_metadata(Path(media_fixture_path("invoke_video.mp4")))
        assert is_recallable_video_record(record)
        payload = build_video_recall_payload(record)
        assert payload["model"] == "Wan 2.2 I2V A14B"
        assert payload["first_frame_image"] == {"image_name": "0f0d1c3e-first.png"}


# ── Router plumbing ───────────────────────────────────────────────────


@pytest.fixture
def invokeai_configured():
    manager = get_config_manager()
    manager.set_invokeai_settings(url=BASE, username=None, password=None, board_id=None)
    invoke_module._invalidate_token_cache()
    invoke_module._invalidate_capabilities_cache()
    yield manager
    manager.set_invokeai_settings(url=None, username=None, password=None, board_id=None)
    invoke_module._invalidate_token_cache()
    invoke_module._invalidate_capabilities_cache()


@pytest.fixture
def media(monkeypatch, tmp_path):
    """Point the router at one file on disk with a chosen metadata record."""
    state: dict = {"record": {}}

    def use(name: str, record: dict | None = None) -> Path:
        path = tmp_path / name
        if name.endswith(".mp4"):
            shutil.copy(media_fixture_path("invoke_video.mp4"), path)
        else:
            path.write_bytes(b"\x89PNG not really")
        state["path"] = path
        state["record"] = {VIDEO_METADATA_KEY: {"fps": 16.0}, **(record or {})}
        return path

    monkeypatch.setattr(invoke_module, "_load_raw_metadata", lambda album_key, index: state["record"])

    def _paths(album_key, index):
        return [state["path"]]

    class _Embeddings:
        @property
        def indexes(self):
            return {"sorted_filenames": _paths(None, None)}

    monkeypatch.setattr(invoke_module, "get_embeddings_for_album", lambda album_key: _Embeddings())
    return use


@pytest.fixture
def upstream(monkeypatch):
    """Route the router's httpx traffic to a scripted handler.

    ``responses`` maps a URL path to a status (or a list of statuses, consumed
    in order); unlisted paths answer 200 with a minimal success body.
    """
    calls: list[httpx.Request] = []
    responses: dict[str, object] = {}
    bodies: dict[str, dict] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        request.read()
        calls.append(request)
        status = responses.get(request.url.path, 200)
        if isinstance(status, list):
            status = status.pop(0) if status else 200
        body = bodies.get(request.url.path) or {
            "status": "success",
            "queue_id": "default",
            "video": {"video_name": UUID_NAME},
            "parameters": {},
            "skipped": [],
            "overridden": {},
        }
        return httpx.Response(status, json=body if status < 400 else {"detail": "nope"})

    real_client = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(invoke_module.httpx, "AsyncClient", factory)
    return {"calls": calls, "responses": responses, "bodies": bodies}


RECALL = "/api/v1/recall/video/default"


class TestVideoRecallRoute:
    def test_requires_configured_url(self, client, media):
        get_config_manager().set_invokeai_settings(url=None, username=None, password=None)
        media("a.mp4", WAN_RECORD)
        response = client.post("/invokeai/video/recall", json={"album_key": "a", "index": 0})
        assert response.status_code == 400
        assert "not configured" in response.json()["detail"]

    def test_recall_is_strict_and_includes_seed(self, client, invokeai_configured, media, upstream):
        media("a.mp4", WAN_RECORD)
        response = client.post("/invokeai/video/recall", json={"album_key": "a", "index": 0})
        assert response.status_code == 200, response.text
        assert response.json()["success"] is True

        (call,) = upstream["calls"]
        assert call.url.path == RECALL
        assert call.url.params["mode"] == "recall"
        assert call.url.params["strict"] == "true"
        sent = json.loads(call.content)
        assert sent["seed"] == 42
        assert VIDEO_METADATA_KEY not in sent

    def test_remix_uses_remix_mode(self, client, invokeai_configured, media, upstream):
        media("a.mp4", WAN_RECORD)
        client.post("/invokeai/video/recall", json={"album_key": "a", "index": 0, "include_seed": False})
        (call,) = upstream["calls"]
        assert call.url.params["mode"] == "remix"
        assert call.url.params["strict"] == "true"

    def test_refuses_images(self, client, invokeai_configured, media, upstream):
        media("a.png", WAN_RECORD)
        response = client.post("/invokeai/video/recall", json={"album_key": "a", "index": 0})
        assert response.status_code == 400
        assert upstream["calls"] == []

    def test_refuses_a_video_without_a_record(self, client, invokeai_configured, media, upstream):
        media("a.mp4", {"Make": "Pixel"})
        response = client.post("/invokeai/video/recall", json={"album_key": "a", "index": 0})
        assert response.status_code == 400
        assert upstream["calls"] == []

    def test_skipped_is_reported(self, client, invokeai_configured, media, upstream):
        media("a.mp4", WAN_RECORD)
        upstream["bodies"][RECALL] = {"status": "success", "skipped": ["vae", "source_video"], "overridden": {}}
        body = client.post("/invokeai/video/recall", json={"album_key": "a", "index": 0}).json()
        assert body["success"] is True
        assert body["skipped"] == ["vae", "source_video"]

    def test_nothing_resolved_is_not_success(self, client, invokeai_configured, media, upstream):
        media("a.mp4", WAN_RECORD)
        upstream["bodies"][RECALL] = {"status": "nothing_resolved", "skipped": ["model"], "parameters": {}}
        body = client.post("/invokeai/video/recall", json={"album_key": "a", "index": 0}).json()
        assert body["success"] is False
        assert "nothing was recalled" in body["message"]

    def test_upstream_error_is_502(self, client, invokeai_configured, media, upstream):
        media("a.mp4", WAN_RECORD)
        upstream["responses"][RECALL] = 422
        response = client.post("/invokeai/video/recall", json={"album_key": "a", "index": 0})
        assert response.status_code == 502
        assert "422" in response.json()["detail"]


    def test_unreadable_media_are_withheld_and_the_rest_recalled(
        self, client, invokeai_configured, media, upstream
    ):
        """A 403 over another user's clip should not cost the prompt and models."""
        media("a.mp4", WAN_RECORD)
        upstream["responses"][RECALL] = [403, 200]
        body = client.post("/invokeai/video/recall", json={"album_key": "a", "index": 0}).json()
        assert body["success"] is True
        assert set(body["skipped"]) >= {"source_video", "source_video_start_frame", "source_video_end_frame"}
        first, second = (json.loads(c.content) for c in upstream["calls"])
        assert "source_video" in first
        assert "source_video" not in second
        assert second["positive_prompt"] == "a heron lands"

    def test_a_403_without_media_is_not_retried(self, client, invokeai_configured, media, upstream):
        media("a.mp4", {k: v for k, v in WAN_RECORD.items() if not k.startswith("source_video")})
        upstream["responses"][RECALL] = 403
        response = client.post("/invokeai/video/recall", json={"album_key": "a", "index": 0})
        assert response.status_code == 502
        assert len(upstream["calls"]) == 1


class TestVideoMediaRoute:
    @pytest.mark.parametrize("target", ["initial", "reference"])
    def test_invoke_named_video_is_placed_by_name(self, client, invokeai_configured, media, upstream, target):
        media(UUID_NAME)
        body = client.post(
            "/invokeai/video/use_media", json={"album_key": "a", "index": 0, "target": target}
        ).json()
        assert body["success"] is True
        assert body["reused_existing"] is True
        (call,) = upstream["calls"]
        assert call.url.path == f"{RECALL}/{target}-video"
        assert call.url.params["video_name"] == UUID_NAME

    def test_missing_by_name_falls_back_to_upload(self, client, invokeai_configured, media, upstream):
        media(UUID_NAME)
        upstream["responses"][f"{RECALL}/reference-video"] = 404
        body = client.post(
            "/invokeai/video/use_media", json={"album_key": "a", "index": 0, "target": "reference"}
        ).json()
        assert body["success"] is True
        assert body["reused_existing"] is False
        assert [c.url.path for c in upstream["calls"]] == [
            f"{RECALL}/reference-video",
            f"{RECALL}/reference-video/upload",
        ]
        upload = upstream["calls"][1]
        assert b'name="file"; filename="' + UUID_NAME.encode() in upload.content

    def test_invoke_record_triggers_the_by_name_attempt(self, client, invokeai_configured, media, upstream):
        media("renamed.mp4", WAN_RECORD)
        client.post("/invokeai/video/use_media", json={"album_key": "a", "index": 0, "target": "initial"})
        assert upstream["calls"][0].url.path == f"{RECALL}/initial-video"

    def test_foreign_video_uploads_directly_to_the_board(self, client, invokeai_configured, media, upstream):
        invokeai_configured.set_invokeai_settings(url=BASE, board_id="board-1")
        media("phone.mp4", {"Make": "Pixel"})
        body = client.post(
            "/invokeai/video/use_media", json={"album_key": "a", "index": 0, "target": "initial"}
        ).json()
        assert body["success"] is True
        (call,) = upstream["calls"]
        assert call.url.path == f"{RECALL}/initial-video/upload"
        assert call.url.params["board_id"] == "board-1"
        assert b"Content-Type: video/mp4" in call.content

    def test_board_failure_falls_back_to_uncategorized(self, client, invokeai_configured, media, upstream):
        invokeai_configured.set_invokeai_settings(url=BASE, board_id="gone")
        media("phone.mp4")
        upstream["responses"][f"{RECALL}/initial-video/upload"] = [404, 200]
        body = client.post(
            "/invokeai/video/use_media", json={"album_key": "a", "index": 0, "target": "initial"}
        ).json()
        assert body["success"] is True
        assert "Uncategorized" in body["warning"]
        first, second = upstream["calls"]
        assert first.url.params["board_id"] == "gone"
        assert "board_id" not in second.url.params

    def test_too_large_is_explained(self, client, invokeai_configured, media, upstream):
        media("phone.mp4")
        upstream["responses"][f"{RECALL}/reference-video/upload"] = 413
        response = client.post(
            "/invokeai/video/use_media", json={"album_key": "a", "index": 0, "target": "reference"}
        )
        assert response.status_code == 502
        assert "upload limit" in response.json()["detail"]

    def test_refuses_images(self, client, invokeai_configured, media, upstream):
        media("a.png")
        response = client.post(
            "/invokeai/video/use_media", json={"album_key": "a", "index": 0, "target": "initial"}
        )
        assert response.status_code == 400
        assert upstream["calls"] == []

    def test_rejects_unknown_target(self, client, invokeai_configured, media, upstream):
        media("a.mp4")
        response = client.post(
            "/invokeai/video/use_media", json={"album_key": "a", "index": 0, "target": "source"}
        )
        assert response.status_code == 422


    def test_a_slow_conversion_is_not_reported_as_unreachable(self, client, invokeai_configured, media, monkeypatch):
        media("phone.mp4")

        def handler(request):
            raise httpx.ReadTimeout("still converting", request=request)

        real_client = httpx.AsyncClient
        monkeypatch.setattr(
            invoke_module.httpx,
            "AsyncClient",
            lambda *a, **k: real_client(*a, **{**k, "transport": httpx.MockTransport(handler)}),
        )
        response = client.post(
            "/invokeai/video/use_media", json={"album_key": "a", "index": 0, "target": "initial"}
        )
        assert response.status_code == 504
        assert "check there before trying again" in response.json()["detail"]


class TestMultiUserBoardRefusal:
    """A board the user may not write to, on a multi-user InvokeAI.

    With a cached token the 403 used to be retried anonymously, come back
    401, and surface as "Not authenticated" with no board fallback — on every
    other click, as the token was dropped and re-fetched in turn.
    """

    def test_every_click_falls_back_to_uncategorized(self, client, invokeai_configured, media, monkeypatch):
        invokeai_configured.set_invokeai_settings(
            url=BASE, username="me@example.com", password="pw", board_id="theirs"
        )
        media("phone.mp4")
        logins = []

        def handler(request: httpx.Request) -> httpx.Response:
            request.read()
            if request.url.path == "/api/v1/auth/login":
                logins.append(request)
                return httpx.Response(200, json={"token": "tok", "expires_in": 3600})
            if "authorization" not in request.headers:
                return httpx.Response(401, json={"detail": "Not authenticated"})
            if request.url.params.get("board_id") == "theirs":
                return httpx.Response(403, json={"detail": "Not your board"})
            return httpx.Response(200, json={"status": "success", "video": {"video_name": UUID_NAME}})

        real_client = httpx.AsyncClient
        monkeypatch.setattr(
            invoke_module.httpx,
            "AsyncClient",
            lambda *a, **k: real_client(*a, **{**k, "transport": httpx.MockTransport(handler)}),
        )
        monkeypatch.setattr(
            "photomap.backend.invokeai_client.httpx.AsyncClient",
            lambda *a, **k: real_client(*a, **{**k, "transport": httpx.MockTransport(handler)}),
        )

        for _click in range(3):
            response = client.post(
                "/invokeai/video/use_media", json={"album_key": "a", "index": 0, "target": "initial"}
            )
            assert response.status_code == 200, response.text
            assert "Uncategorized" in response.json()["warning"]
        # The token was good all along, so it is fetched once, not per click.
        assert len(logins) == 1


class TestVideoRecallCapability:
    def _probe(self, client, upstream, paths: dict) -> dict:
        upstream["bodies"]["/openapi.json"] = {"paths": paths}
        return client.get("/invokeai/capabilities?refresh=true").json()

    def test_detected_from_openapi(self, client, invokeai_configured, upstream):
        caps = self._probe(
            client,
            upstream,
            {
                "/api/v1/recall/{queue_id}": {"post": {"parameters": []}},
                "/api/v1/recall/video/{queue_id}": {"post": {}},
            },
        )
        assert caps["video_recall"] is True

    def test_absent_on_older_backends(self, client, invokeai_configured, upstream):
        caps = self._probe(client, upstream, {"/api/v1/recall/{queue_id}": {"post": {"parameters": []}}})
        assert caps["recall"] is True
        assert caps["video_recall"] is False

    def test_image_placement_detected_from_openapi(self, client, invokeai_configured, upstream):
        paths = {
            "/api/v1/recall/{queue_id}": {"post": {"parameters": []}},
            "/api/v1/recall/video/{queue_id}": {"post": {}},
        }
        assert self._probe(client, upstream, paths)["video_image"] is False
        paths["/api/v1/recall/video/{queue_id}/image"] = {"post": {}}
        assert self._probe(client, upstream, paths)["video_image"] is True


class TestImageToVideoPanel:
    """``/invokeai/use_ref_image`` with ``target="video"``: the drawer's Send /
    Append Image buttons with "video generation" chosen."""

    @pytest.fixture
    def uploaded(self, upstream):
        upstream["bodies"]["/api/v1/images/upload"] = {"image_name": "uploaded.png"}
        return upstream

    @pytest.mark.parametrize("append", [False, True])
    def test_uploads_then_places_the_image_in_the_video_panel(
        self, client, invokeai_configured, media, uploaded, append
    ):
        media("still.png")

        response = client.post(
            "/invokeai/use_ref_image",
            json={"album_key": "a", "index": 0, "append": append, "target": "video"},
        )

        assert response.status_code == 200, response.text
        assert response.json()["target"] == "video"
        upload, place = uploaded["calls"]
        assert upload.url.path == "/api/v1/images/upload"
        assert place.url.path == "/api/v1/recall/video/default/image"
        assert dict(place.url.params) == {
            "image_name": "uploaded.png",
            "append": "true" if append else "false",
        }
        assert place.content == b""

    def test_the_image_target_still_goes_to_the_image_recall(self, client, invokeai_configured, media, uploaded):
        media("still.png")

        response = client.post("/invokeai/use_ref_image", json={"album_key": "a", "index": 0})

        assert response.status_code == 200, response.text
        assert uploaded["calls"][-1].url.path == "/api/v1/recall/default"

    def test_an_upstream_refusal_is_a_502(self, client, invokeai_configured, media, uploaded):
        media("still.png")
        uploaded["responses"]["/api/v1/recall/video/default/image"] = 404

        response = client.post(
            "/invokeai/use_ref_image", json={"album_key": "a", "index": 0, "target": "video"}
        )

        assert response.status_code == 502

    def test_an_unknown_target_is_rejected(self, client, invokeai_configured, media, uploaded):
        media("still.png")

        response = client.post(
            "/invokeai/use_ref_image", json={"album_key": "a", "index": 0, "target": "audio"}
        )

        assert response.status_code == 422
        assert uploaded["calls"] == []
