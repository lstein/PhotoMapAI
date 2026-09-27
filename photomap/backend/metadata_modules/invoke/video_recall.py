"""Translate an InvokeAI video generation record into a video recall request.

InvokeAI's record (``invokeai_metadata`` in the MP4, or the pre-7 JSON
sidecar) and the body of its ``POST /api/v1/recall/video/{queue_id}`` route
share field names, but not a contract: the record is read tolerantly and may
carry any key, while the request model is ``extra="forbid"`` and takes models
by name and LoRAs as ``model_name``. So the translation is a whitelist over
the raw dict rather than a dump of the parsed Pydantic model — which also
carries the ``ltx2_*`` fields that PhotoMap's ``GenerationMetadata5`` does not
declare.

The request model also refuses the *whole* request (422) over one value it
does not accept, so every field is checked here against the request's bounds
and dropped on its own when it fails — in the spirit of InvokeAI's own "a
newer record still recalls what it can".
"""

from __future__ import annotations

from typing import Any

from ..invokemetadata import looks_like_invoke_metadata
from .invoke5metadata import _WAN_KEY_ALIASES
from .invoke_metadata_view import _VIDEO_PROFILE_ATTRS

_SEED_MAX = 2**32 - 1
_MAX_NAME = 255
_MAX_LORAS = 32
_MAX_REFERENCE_VIDEOS = 3
_MAX_REFERENCE_IMAGES = 9

# (field, type, minimum, maximum) — the upstream request's bounds.
_INT_FIELDS = (
    ("seed", 0, _SEED_MAX),
    ("num_frames", 1, None),
    ("fps", 1, 120),
    ("width", 1, None),
    ("height", 1, None),
    ("steps", 1, None),
    ("ltx2_context_frames", 1, None),
    ("minimax_h3_hybrid_start_block", 0, None),
)
_FLOAT_FIELDS = (
    ("cfg_scale", 1, None),
    ("wan_guidance_scale_low_noise", 1, None),
    ("ltx2_audio_cfg_scale", 1, None),
    ("ltx2_stg_scale", 0, None),
    ("ltx2_modality_scale", 1, None),
)

# Recorded as a ModelIdentifier ``{key, hash, name, base, type}``; sent by name.
_MODEL_FIELDS = (
    "model",
    "vae",
    "wan_t5_encoder_model",
    "wan_transformer_low_noise",
    "wan_component_source",
    "minimax_h3_transformer_model",
    "minimax_h3_component_source",
    "minimax_h3_text_encoder_model",
    "minimax_h3_hybrid_base_model",
    "ltx2_component_source",
    "ltx2_text_encoder_model",
)

_IMAGE_REF_FIELDS = ("first_frame_image", "last_frame_image")
_VIDEO_REF_FIELDS = ("source_video", "ltx2_conditioning_video")

# Every media field, for callers that need to retry a recall without them.
MEDIA_FIELDS = (
    *_IMAGE_REF_FIELDS,
    *_VIDEO_REF_FIELDS,
    "source_video_start_frame",
    "source_video_end_frame",
    "ltx2_conditioning_role",
    "minimax_h3_references",
)

_CONDITIONING_ROLES = {"audio", "video"}
_REFERENCE_DETAILS = {"max", "match"}
_REFERENCE_CONDITIONINGS = {"video_audio", "video", "audio"}

# ``generation_mode`` prefixes of InvokeAI's video architectures. Only a
# supporting signal: the video-only fields are the primary one, because this
# list grows with every architecture InvokeAI adds.
_VIDEO_MODE_PREFIXES = ("wan_", "minimax_h3_", "ltx")


def _normalized(raw: dict) -> dict:
    """A copy of ``raw`` with the pre-1.0 Wan spellings folded onto the canonical ones."""
    record = dict(raw)
    for legacy, canonical in _WAN_KEY_ALIASES.items():
        if legacy in record:
            value = record.pop(legacy)
            record.setdefault(canonical, value)
    return record


def is_recallable_video_record(metadata: dict) -> bool:
    """True iff ``metadata`` is an InvokeAI video generation record with
    something to recall.

    Checked on the raw dict, not by parsing it: one malformed entry (a LoRA
    without a name, say) fails the Pydantic parse, but the translation
    simply skips it, so it should not cost the video its Recall button.
    ``media_origin`` alone is not a generation: InvokeAI sets it on uploads.
    """
    if not metadata or not looks_like_invoke_metadata(metadata):
        return False
    record = _normalized(metadata)
    mode = record.get("generation_mode")
    is_video = (
        any(
            record.get(attribute) is not None
            for attribute in _VIDEO_PROFILE_ATTRS
            if attribute != "media_origin"
        )
        or any(key.startswith("ltx2_") for key in record)
        or (isinstance(mode, str) and mode.startswith(_VIDEO_MODE_PREFIXES))
    )
    if not is_video:
        return False
    payload = build_video_recall_payload(record)
    return bool(payload.get("model") or payload.get("positive_prompt"))


def _int(value: Any, minimum: int, maximum: int | None) -> int | None:
    """``value`` as an int within bounds, or None. Integral floats count."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    if isinstance(value, float):
        if not value.is_integer():
            return None
        value = int(value)
    if value < minimum or (maximum is not None and value > maximum):
        return None
    return value


def _float(value: Any, minimum: float, maximum: float | None) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    if value != value or value < minimum or (maximum is not None and value > maximum):
        return None  # NaN fails its own comparison, so it is caught first
    return value


def _name(value: Any) -> str | None:
    return value if isinstance(value, str) and 0 < len(value) <= _MAX_NAME else None


def _model_name(value: Any) -> str | None:
    if isinstance(value, dict):
        return _name(value.get("name")) or _name(value.get("key"))
    return _name(value)


def _media_ref(value: Any, key: str) -> dict[str, str] | None:
    if isinstance(value, dict):
        name = _name(value.get(key))
        if name:
            return {key: name}
    return None


def _trim(start: Any, end: Any) -> tuple[int, int] | None:
    """A whole, ordered trim, or None: InvokeAI refuses half or reversed ones."""
    start, end = _int(start, 0, None), _int(end, 0, None)
    if start is None or end is None or start > end:
        return None
    return start, end


def _loras(value: Any) -> list[dict[str, Any]] | None:
    if not isinstance(value, list):
        return None
    loras = []
    for entry in value:
        if not isinstance(entry, dict):
            continue
        name = _model_name(entry.get("model")) or _model_name(entry.get("lora"))
        if not name:
            continue
        lora: dict[str, Any] = {"model_name": name}
        if "weight" in entry and entry["weight"] is not None:
            weight = _float(entry["weight"], -10, 10)
            if weight is None:
                continue  # an out-of-range weight is not the weight the user had
            lora["weight"] = weight
        loras.append(lora)
    return loras[:_MAX_LORAS]


def _reference(entry: Any) -> dict[str, Any] | None:
    if not isinstance(entry, dict):
        return None
    kind = entry.get("kind")
    if kind == "image":
        name = _name(entry.get("image_name"))
        if not name:
            return None
        reference: dict[str, Any] = {"kind": "image", "image_name": name}
        if entry.get("detail") in _REFERENCE_DETAILS:
            reference["detail"] = entry["detail"]
        return reference
    if kind == "video":
        name = _name(entry.get("video_name"))
        if not name:
            return None
        reference = {"kind": "video", "video_name": name}
        if entry.get("conditioning") in _REFERENCE_CONDITIONINGS:
            reference["conditioning"] = entry["conditioning"]
        trim = _trim(entry.get("start_frame"), entry.get("end_frame"))
        if trim:
            reference["start_frame"], reference["end_frame"] = trim
        return reference
    return None


def _references(value: Any) -> list[dict[str, Any]] | None:
    if not isinstance(value, list):
        return None
    references = []
    counts = {"image": 0, "video": 0}
    limits = {"image": _MAX_REFERENCE_IMAGES, "video": _MAX_REFERENCE_VIDEOS}
    for entry in value:
        reference = _reference(entry)
        if reference is None or counts[reference["kind"]] >= limits[reference["kind"]]:
            continue
        counts[reference["kind"]] += 1
        references.append(reference)
    return references


def build_video_recall_payload(raw: dict) -> dict[str, Any]:
    """Build a ``VideoRecallParameter`` body from a raw video generation record.

    Includes the seed; InvokeAI drops it itself when the request is sent with
    ``mode=remix``. Media the linked backend does not have are left for
    InvokeAI to report in its ``skipped`` list; values the request model
    would refuse are dropped here, field by field.
    """
    record = _normalized(raw)
    payload: dict[str, Any] = {}

    if isinstance(record.get("positive_prompt"), str):
        payload["positive_prompt"] = record["positive_prompt"]
    # An explicit null turns InvokeAI's negative prompt off, so pass through
    # whatever the record says — but only when it says something.
    if "negative_prompt" in record and (
        record["negative_prompt"] is None or isinstance(record["negative_prompt"], str)
    ):
        payload["negative_prompt"] = record["negative_prompt"]

    for field, minimum, maximum in _INT_FIELDS:
        value = _int(record.get(field), minimum, maximum)
        if value is not None:
            payload[field] = value
    for field, minimum, maximum in _FLOAT_FIELDS:
        value = _float(record.get(field), minimum, maximum)
        if value is not None:
            payload[field] = value

    for field in _MODEL_FIELDS:
        name = _model_name(record.get(field))
        if name:
            payload[field] = name
    for field in _IMAGE_REF_FIELDS:
        ref = _media_ref(record.get(field), "image_name")
        if ref:
            payload[field] = ref

    source = _media_ref(record.get("source_video"), "video_name")
    if source:
        payload["source_video"] = source
        trim = _trim(record.get("source_video_start_frame"), record.get("source_video_end_frame"))
        if trim:
            payload["source_video_start_frame"], payload["source_video_end_frame"] = trim

    # The conditioning clip and its role are both-or-neither upstream.
    conditioning = _media_ref(record.get("ltx2_conditioning_video"), "video_name")
    role = record.get("ltx2_conditioning_role")
    if conditioning and role in _CONDITIONING_ROLES:
        payload["ltx2_conditioning_video"] = conditioning
        payload["ltx2_conditioning_role"] = role

    loras = _loras(record.get("loras"))
    if loras is not None:
        payload["loras"] = loras
    references = _references(record.get("minimax_h3_references"))
    if references:
        payload["minimax_h3_references"] = references
    return payload
