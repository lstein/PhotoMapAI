"""Regression tests for the refactored InvokeAI metadata pipeline.

Two layers are covered:

1. ``InvokeMetadataView`` — the version-agnostic wrapper that mediates
   between the Pydantic discriminated union (v2 / v3 / v5) and the
   ``invoke_formatter``. Each logical field (prompts, model, seed, loras,
   reference images, control layers, raster images) is asserted against
   every metadata version that meaningfully carries it.
2. ``format_invoke_metadata`` — the HTML renderer consumed by
   ``metadata-drawer``. Tests assert the rendered HTML contains the
   expected table rows and that ``slide_data.reference_images`` is
   populated for downstream consumers.
"""

from __future__ import annotations

import pytest

from photomap.backend.metadata_modules.invoke.invoke_metadata_view import (
    ControlLayerTuple,
    InvokeMetadataView,
    LoraTuple,
    ReferenceImageTuple,
)
from photomap.backend.metadata_modules.invoke_formatter import (
    format_invoke_metadata,
    use_ref_button_html,
)
from photomap.backend.metadata_modules.invokemetadata import (
    GenerationMetadataAdapter,
    looks_like_invoke_metadata,
)
from photomap.backend.metadata_modules.slide_summary import SlideSummary

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _slide() -> SlideSummary:
    return SlideSummary(filename="sample.png", filepath="")


def _view(data: dict) -> InvokeMetadataView:
    return InvokeMetadataView(GenerationMetadataAdapter().parse(data))


@pytest.fixture
def v2_scalar_prompt_metadata() -> dict:
    """Legacy InvokeAI v2 with a scalar prompt and model_weights."""
    return {
        "app_id": "invoke-ai/InvokeAI-Stable-Diffusion",
        "app_version": "2.3.5",
        "model": "stable_diffusion_v1_5",
        "model_weights": "stable-diffusion-1.5",
        "model_hash": "abc123",
        "image": {
            "prompt": "a mountain landscape",
            "seed": 1234,
            "cfg_scale": 7.5,
            "height": 512,
            "width": 768,
            "sampler": "k_euler_a",
            "steps": 20,
            "type": "txt2img",
            "postprocessing": None,
        },
    }


@pytest.fixture
def v2_list_prompt_metadata() -> dict:
    """Very old InvokeAI v2 with the list-of-weighted-prompts variant."""
    return {
        "app_id": "invoke-ai/InvokeAI-Stable-Diffusion",
        "app_version": "2.2.0",
        "model": "legacy_model",
        "model_hash": "xyz",
        "image": {
            "prompt": [{"prompt": "old style prompt", "weight": 1.0}],
            "seed": 999,
            "cfg_scale": 7.0,
            "height": 512,
            "width": 512,
            "sampler": "k_lms",
            "steps": 10,
            "type": "txt2img",
            "postprocessing": None,
        },
    }


@pytest.fixture
def v3_metadata() -> dict:
    """InvokeAI v3 with LoRAs, IP adapters, and controlnets."""
    return {
        "metadata_version": 3,
        "app_version": "3.5.0",
        "generation_mode": "txt2img",
        "positive_prompt": "a cat riding a skateboard",
        "negative_prompt": "blurry, low quality",
        "seed": 42,
        "model": {"model_name": "dreamshaper", "base_model": "sd-1"},
        "loras": [
            {"lora": {"model_name": "detail_lora"}, "weight": 0.8},
            {"lora": {"model_name": "style_lora"}, "weight": 0.5},
        ],
        "ipAdapters": [
            {
                "ip_adapter_model": {"model_name": "ip_adapter_sd15"},
                "image": {"image_name": "ref.png"},
                "weight": 0.5,
            }
        ],
        "controlnets": [
            {
                "control_model": {"model_name": "canny_sd15"},
                "image": {"image_name": "control.png"},
                "control_weight": 0.7,
                "beginEndStepPct": [0.0, 1.0],
                "control_mode": "balanced",
            }
        ],
    }


@pytest.fixture
def v5_ref_images_metadata() -> dict:
    """Modern InvokeAI v5 using the ``ref_images`` field."""
    return {
        "metadata_version": 5,
        "app_version": "5.6.0",
        "positive_prompt": "a dog in a hat",
        "negative_prompt": "ugly, deformed",
        "seed": 100,
        "model": {"name": "flux-schnell", "base": "flux"},
        "loras": [{"lora": {"name": "dog_lora"}, "weight": 0.6}],
        "ref_images": [
            {
                "id": "r1",
                "isEnabled": True,
                "config": {
                    "type": "ipAdapter",
                    "model": {"name": "ipa-flux"},
                    "image": {"image_name": "ref1.png"},
                    "weight": 0.7,
                },
            },
            {
                "id": "r2",
                "isEnabled": False,  # should be filtered out
                "config": {
                    "type": "ipAdapter",
                    "model": {"name": "ipa-flux"},
                    "image": {"image_name": "ref2.png"},
                    "weight": 0.3,
                },
            },
        ],
        "control_layers": {
            "version": 1,
            "layers": [
                {
                    "id": "cl1",
                    "type": "control_layer",
                    "isEnabled": True,
                    "isSelected": False,
                    "ipAdapter": {
                        "model": {"name": "canny_flux"},
                        "image": {"image_name": "edges.png"},
                        "weight": 0.9,
                    },
                },
                {
                    "id": "cl2",
                    "type": "control_layer",
                    "isEnabled": False,  # should be filtered out
                    "isSelected": False,
                    "ipAdapter": {
                        "model": {"name": "depth_flux"},
                        "image": {"image_name": "depth.png"},
                        "weight": 0.5,
                    },
                },
            ],
        },
    }


@pytest.fixture
def v5_canvas_metadata() -> dict:
    """InvokeAI v5 using the older ``canvas_v2_metadata`` layout."""
    return {
        "app_version": "5.0.0",
        "positive_prompt": "a bird over the ocean",
        "negative_prompt": "blurry",
        "seed": 7,
        "model": {"name": "sdxl", "base": "sdxl"},
        "canvas_v2_metadata": {
            "rasterLayers": [
                {
                    "id": "rl1",
                    "isEnabled": True,
                    "isLocked": False,
                    "name": None,
                    "objects": [
                        {"id": "o1", "type": "image",
                         "image": {"image_name": "raster1.png"}},
                        {"id": "o2", "type": "image",
                         "image": {"image_name": "raster2.png"}},
                    ],
                    "opacity": 1.0,
                    "position": {"x": 0, "y": 0},
                    "type": "raster_layer",
                },
                {
                    "id": "rl2",
                    "isEnabled": False,  # should be filtered out
                    "isLocked": False,
                    "name": None,
                    "objects": [
                        {"id": "o3", "type": "image",
                         "image": {"image_name": "raster_disabled.png"}},
                    ],
                    "opacity": 1.0,
                    "position": {"x": 0, "y": 0},
                    "type": "raster_layer",
                },
            ],
            "referenceImages": [
                {
                    "id": "ri1",
                    "isEnabled": True,
                    "isLocked": False,
                    "name": None,
                    "ipAdapter": {
                        "model": {"name": "ipa-sdxl"},
                        "image": {"image_name": "ip_ref.png"},
                        "weight": 0.5,
                    },
                },
            ],
            "controlLayers": [
                {
                    "id": "cl1",
                    "isEnabled": True,
                    "isLocked": False,
                    "name": None,
                    "objects": [
                        {"id": "co1", "type": "image",
                         "image": {"image_name": "cl_img.png"}},
                    ],
                    "opacity": 1.0,
                    "position": {"x": 0, "y": 0},
                    "type": "control_layer",
                    "withTransparencyEffect": False,
                    "controlAdapter": {
                        "control_model": {"name": "canny_sdxl"},
                        "image": {"image_name": "cl_img.png"},
                        "control_weight": 0.6,
                        "beginEndStepPct": [0.0, 1.0],
                        "controlMode": "balanced",
                    },
                },
            ],
        },
    }


# ---------------------------------------------------------------------------
# InvokeMetadataView — v2
# ---------------------------------------------------------------------------


class TestInvokeMetadataViewV2:
    def test_scalar_prompt(self, v2_scalar_prompt_metadata):
        view = _view(v2_scalar_prompt_metadata)
        assert view.positive_prompt == "a mountain landscape"
        assert view.negative_prompt == ""
        # model_weights takes precedence over plain model
        assert view.model_name == "stable-diffusion-1.5"
        assert view.seed == 1234

    def test_list_prompt_takes_first_entry(self, v2_list_prompt_metadata):
        view = _view(v2_list_prompt_metadata)
        assert view.positive_prompt == "old style prompt"
        assert view.negative_prompt == ""
        # no model_weights — falls back to model
        assert view.model_name == "legacy_model"
        assert view.seed == 999

    def test_empty_collections(self, v2_scalar_prompt_metadata):
        view = _view(v2_scalar_prompt_metadata)
        assert view.loras == []
        assert view.reference_images == []
        assert view.control_layers == []
        assert view.raster_images == []


# ---------------------------------------------------------------------------
# InvokeMetadataView — v3
# ---------------------------------------------------------------------------


class TestInvokeMetadataViewV3:
    def test_prompts_model_seed(self, v3_metadata):
        view = _view(v3_metadata)
        assert view.positive_prompt == "a cat riding a skateboard"
        assert view.negative_prompt == "blurry, low quality"
        assert view.model_name == "dreamshaper"
        assert view.seed == 42

    def test_loras(self, v3_metadata):
        view = _view(v3_metadata)
        assert view.loras == [
            LoraTuple(model_name="detail_lora", weight=0.8),
            LoraTuple(model_name="style_lora", weight=0.5),
        ]

    def test_reference_images_from_ip_adapters(self, v3_metadata):
        view = _view(v3_metadata)
        assert view.reference_images == [
            ReferenceImageTuple(
                model_name="ip_adapter_sd15",
                image_name="ref.png",
                weight=0.5,
            )
        ]

    def test_control_layers_from_controlnets(self, v3_metadata):
        view = _view(v3_metadata)
        assert view.control_layers == [
            ControlLayerTuple(
                model_name="canny_sd15",
                image_name="control.png",
                weight=0.7,
            )
        ]

    def test_no_raster_images(self, v3_metadata):
        view = _view(v3_metadata)
        assert view.raster_images == []


# ---------------------------------------------------------------------------
# InvokeMetadataView — v5 (ref_images path)
# ---------------------------------------------------------------------------


class TestInvokeMetadataViewV5RefImages:
    def test_prompts_model_seed(self, v5_ref_images_metadata):
        view = _view(v5_ref_images_metadata)
        assert view.positive_prompt == "a dog in a hat"
        assert view.negative_prompt == "ugly, deformed"
        assert view.model_name == "flux-schnell"
        assert view.seed == 100

    def test_loras(self, v5_ref_images_metadata):
        view = _view(v5_ref_images_metadata)
        assert view.loras == [LoraTuple(model_name="dog_lora", weight=0.6)]

    def test_ref_images_skips_disabled(self, v5_ref_images_metadata):
        view = _view(v5_ref_images_metadata)
        assert view.reference_images == [
            ReferenceImageTuple(
                model_name="ipa-flux", image_name="ref1.png", weight=0.7
            )
        ]

    def test_control_layers_skips_disabled(self, v5_ref_images_metadata):
        view = _view(v5_ref_images_metadata)
        assert view.control_layers == [
            ControlLayerTuple(
                model_name="canny_flux", image_name="edges.png", weight=0.9
            )
        ]

    def test_no_raster_images_without_canvas(self, v5_ref_images_metadata):
        view = _view(v5_ref_images_metadata)
        assert view.raster_images == []


# ---------------------------------------------------------------------------
# InvokeMetadataView — v5 (canvas_v2_metadata path)
# ---------------------------------------------------------------------------


class TestInvokeMetadataViewV5Canvas:
    def test_prompts_model_seed(self, v5_canvas_metadata):
        view = _view(v5_canvas_metadata)
        assert view.positive_prompt == "a bird over the ocean"
        assert view.negative_prompt == "blurry"
        assert view.model_name == "sdxl"
        assert view.seed == 7

    def test_reference_images_from_canvas(self, v5_canvas_metadata):
        view = _view(v5_canvas_metadata)
        assert view.reference_images == [
            ReferenceImageTuple(
                model_name="ipa-sdxl", image_name="ip_ref.png", weight=0.5
            )
        ]

    def test_control_layers_join_object_images(self, v5_canvas_metadata):
        view = _view(v5_canvas_metadata)
        assert view.control_layers == [
            ControlLayerTuple(
                model_name="canny_sdxl", image_name="cl_img.png", weight=0.6
            )
        ]

    def test_raster_images_skip_disabled_layers(self, v5_canvas_metadata):
        view = _view(v5_canvas_metadata)
        assert view.raster_images == ["raster1.png", "raster2.png"]


# ---------------------------------------------------------------------------
# GenerationMetadata5 — unknown-field warning
# ---------------------------------------------------------------------------


class TestV5UnknownFieldWarning:
    """``extra="allow"`` keeps parsing forward-compatible, but the
    ``_warn_unknown_fields`` model_validator surfaces drift so it doesn't
    go un-noticed. Each new field name is logged once per process; repeats
    are silent."""

    @pytest.fixture(autouse=True)
    def _reset_warned(self):
        # ``_warned_extra_fields`` is module-level; clear it around each test
        # so order doesn't influence what counts as "first-time-seen".
        from photomap.backend.metadata_modules.invoke import invoke5metadata

        invoke5metadata._warned_extra_fields.clear()
        yield
        invoke5metadata._warned_extra_fields.clear()

    def _v5_with(self, **extra) -> dict:
        return {
            "metadata_version": 5,
            "app_version": "5.6.0",
            "model": {"name": "test"},
            "positive_prompt": "p",
            "seed": 1,
            **extra,
        }

    def test_logs_unknown_field_on_first_encounter(self, caplog):
        import logging

        with caplog.at_level(logging.WARNING):
            GenerationMetadataAdapter().parse(
                self._v5_with(brand_new_field=42, another_one="x")
            )
        # Both unknown fields appear in a single warning, comma-separated and sorted.
        record = next(r for r in caplog.records if r.levelno == logging.WARNING)
        assert "another_one" in record.getMessage()
        assert "brand_new_field" in record.getMessage()

    def test_does_not_warn_for_known_fields(self, caplog):
        import logging

        with caplog.at_level(logging.WARNING):
            GenerationMetadataAdapter().parse(self._v5_with())
        # No warnings — every field we set is in the schema.
        assert not any(r.levelno == logging.WARNING for r in caplog.records)

    def test_repeats_are_silent(self, caplog):
        import logging

        adapter = GenerationMetadataAdapter()
        with caplog.at_level(logging.WARNING):
            adapter.parse(self._v5_with(brand_new_field=42))
            # Drop the first-encounter warning so the second parse can be
            # asserted silent on its own.
            caplog.clear()
            adapter.parse(self._v5_with(brand_new_field=42))
        assert not any(r.levelno == logging.WARNING for r in caplog.records)

    def test_new_field_after_seen_one_does_warn(self, caplog):
        import logging

        adapter = GenerationMetadataAdapter()
        with caplog.at_level(logging.WARNING):
            adapter.parse(self._v5_with(first_field=1))
            caplog.clear()
            adapter.parse(self._v5_with(first_field=1, second_field=2))
        # Only ``second_field`` is mentioned in the second warning;
        # ``first_field`` was already in ``_warned_extra_fields`` from the
        # call above.
        warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
        assert len(warnings) == 1
        msg = warnings[0].getMessage()
        assert "second_field" in msg
        assert "first_field" not in msg

# ---------------------------------------------------------------------------
# GenerationMetadataAdapter._infer_metadata_version — discriminator heuristics
# ---------------------------------------------------------------------------


class TestDiscriminatorHeuristics:
    """Pre-discriminator payloads (no ``metadata_version`` key) get their
    schema version inferred. ``app_version`` is the authoritative signal
    when present; structural fingerprints are the fallback.

    Tests call the heuristic directly via ``_infer_metadata_version`` so
    they don't have to construct payloads complete enough to satisfy each
    full schema — the point here is the version *picked*, not the parse.
    """

    def _infer(self, payload: dict) -> int:
        return GenerationMetadataAdapter._infer_metadata_version(payload)

    def test_app_version_beats_canvas_v2_marker(self):
        # A v3 image that happens to carry a ``canvas_v2_metadata`` key
        # must still infer v3 — ``app_version`` is more authoritative than
        # any individual field's presence. Previously this was forced to v5.
        assert self._infer({"app_version": "3.4.0", "canvas_v2_metadata": {}}) == 3

    def test_v_prefixed_v3_app_version(self):
        # InvokeAI has shipped both bare and ``v``-prefixed version strings;
        # accept ``v3.x.y`` the same way the older v2 branch already accepted
        # ``v2.x.y``.
        assert self._infer({"app_version": "v3.4.0"}) == 3

    def test_v3_with_string_model_falls_back_to_v2(self):
        # Some v3-era payloads stored ``model`` as a string; v3's schema
        # requires the richer Model object so the heuristic classifies them
        # as v2 (which accepts a string ``model``).
        assert self._infer({"app_version": "3.4.0", "model": "sd-1.5"}) == 2

    def test_no_app_version_canvas_marker_picks_v5(self):
        # Structural fallback: ``canvas_v2_metadata`` without ``app_version``
        # still implies v5.
        assert self._infer({"canvas_v2_metadata": {}}) == 5

    def test_no_app_version_model_weights_picks_v2(self):
        # Structural fallback for legacy v2 payloads (no ``app_version`` and
        # no ``canvas_v2_metadata``, but ``model_weights`` is set).
        assert self._infer({"model_weights": "x"}) == 2

    def test_no_signals_defaults_to_v3(self):
        # The most-common pre-stamped payload shape — assume v3 when nothing
        # else gives us a hint.
        assert self._infer({"positive_prompt": "p", "seed": 1}) == 3

    def test_future_app_version_picks_v5(self):
        # Any ``app_version`` we don't explicitly recognise (4.x, 5.x, 6.x)
        # routes to v5 since that's the active schema.
        assert self._infer({"app_version": "6.0.0"}) == 5


# ---------------------------------------------------------------------------
# format_invoke_metadata — end-to-end HTML rendering
# ---------------------------------------------------------------------------


class TestFormatInvokeMetadata:
    def test_empty_metadata_returns_placeholder(self):
        slide = _slide()
        result = format_invoke_metadata(slide, {})
        assert "No invoke metadata available" in result.description

    def test_scalar_only_metadata_uses_key_value_table(self):
        slide = _slide()
        metadata = {
            "Custom Field": "value",
            "Seed": 1234,
            "Steps": 20,
        }
        result = format_invoke_metadata(slide, metadata)
        assert "<table class='invoke-metadata'>" in result.description
        assert "<th>Custom Field</th><td>value</td>" in result.description
        assert "<th>Seed</th><td>1234</td>" in result.description

    def test_v2_renders_prompt_model_seed(self, v2_scalar_prompt_metadata):
        slide = _slide()
        result = format_invoke_metadata(slide, v2_scalar_prompt_metadata)
        html = result.description
        assert "<table class='invoke-metadata'>" in html
        assert "Positive Prompt" in html
        assert "a mountain landscape" in html
        assert "stable-diffusion-1.5" in html
        assert "1234" in html
        # No loras/controls/references in v2
        assert "Loras" not in html
        assert "Reference Images" not in html
        assert "Control Layers" not in html
        assert result.reference_images == []

    def test_v3_renders_all_sections(self, v3_metadata):
        slide = _slide()
        result = format_invoke_metadata(slide, v3_metadata)
        html = result.description
        for snippet in [
            "Positive Prompt",
            "a cat riding a skateboard",
            "Negative Prompt",
            "blurry, low quality",
            "<th>Model</th><td>dreamshaper</td>",
            "<th>Seed</th>",
            "42",
            "Loras",
            "detail_lora",
            "style_lora",
            "Reference Images",
            "ip_adapter_sd15",
            "ref.png",
            "Control Layers",
            "canny_sd15",
            "control.png",
        ]:
            assert snippet in html, f"missing {snippet!r} in rendered HTML"
        # Reference images collected for downstream thumbnail rendering
        assert "ref.png" in result.reference_images
        assert "control.png" in result.reference_images

    def test_v5_ref_images_path(self, v5_ref_images_metadata):
        slide = _slide()
        result = format_invoke_metadata(slide, v5_ref_images_metadata)
        html = result.description
        assert "a dog in a hat" in html
        assert "flux-schnell" in html
        assert "ipa-flux" in html
        assert "ref1.png" in html
        # disabled ref image must not appear
        assert "ref2.png" not in html
        # control layer (enabled) rendered; disabled one skipped
        assert "canny_flux" in html
        assert "depth_flux" not in html
        assert "ref1.png" in result.reference_images
        assert "edges.png" in result.reference_images

    def test_v5_canvas_path_raster_images(self, v5_canvas_metadata):
        slide = _slide()
        result = format_invoke_metadata(slide, v5_canvas_metadata)
        html = result.description
        assert "Raster Images" in html
        assert "raster1.png" in html
        assert "raster2.png" in html
        # Disabled raster layer filtered out
        assert "raster_disabled.png" not in html
        # Canvas reference image + control layer rows present
        assert "ipa-sdxl" in html
        assert "ip_ref.png" in html
        assert "canny_sdxl" in html
        # reference_images is ref + control layer image names, plus raster
        assert "ip_ref.png" in result.reference_images
        assert "cl_img.png" in result.reference_images
        assert "raster1.png" in result.reference_images
        assert "raster2.png" in result.reference_images


# ---------------------------------------------------------------------------
# Empty-field handling in the rendered HTML
# ---------------------------------------------------------------------------


class TestFormatInvokeMetadataEmptyFields:
    """Tweaks to how the formatter handles empty / missing field values."""

    def test_empty_negative_prompt_suppresses_row(self):
        """A blank negative_prompt should not produce a Negative Prompt row."""
        metadata = {
            "metadata_version": 3,
            "app_version": "3.5.0",
            "positive_prompt": "anything",
            "negative_prompt": "",
            "seed": 1,
            "model": {"model_name": "m"},
        }
        html = format_invoke_metadata(_slide(), metadata).description
        assert "Negative Prompt" not in html

    def test_empty_positive_prompt_suppresses_copy_icon_only(self):
        """Blank positive_prompt keeps the row but drops the copy icon."""
        metadata = {
            "metadata_version": 3,
            "app_version": "3.5.0",
            "positive_prompt": "",
            "negative_prompt": "dont want this",
            "seed": 1,
            "model": {"model_name": "m"},
        }
        html = format_invoke_metadata(_slide(), metadata).description
        # Row is still present so the drawer always shows a positive prompt slot
        assert "<th>Positive Prompt</th>" in html
        # But the copy icon (identifiable by its class) must NOT be on that row
        # Extract just the Positive Prompt row to check
        start = html.index("<th>Positive Prompt</th>")
        end = html.index("</tr>", start)
        positive_row = html[start:end]
        assert "copy-icon" not in positive_row
        # The Negative Prompt row does still carry a copy icon (sanity check
        # that we haven't accidentally dropped icons everywhere)
        assert "Negative Prompt" in html
        neg_start = html.index("<th>Negative Prompt</th>")
        neg_end = html.index("</tr>", neg_start)
        assert "copy-icon" in html[neg_start:neg_end]

    def test_reference_image_row_omits_empty_model_and_weight(self):
        """Tuple cells for missing model / weight should be dropped."""
        metadata = {
            "metadata_version": 5,
            "app_version": "5.6.0",
            "positive_prompt": "x",
            "seed": 1,
            "model": {"name": "m"},
            "ref_images": [
                {
                    "id": "r1",
                    "isEnabled": True,
                    "config": {
                        "type": "ipAdapter",
                        # no model, no weight
                        "image": {"image_name": "only_image.png"},
                    },
                }
            ],
        }
        html = format_invoke_metadata(_slide(), metadata).description
        assert "Reference Images" in html
        assert "only_image.png" in html
        # Extract the inner tuple-table row and assert it has exactly one <td>
        start = html.index("<table class='invoke-tuples'>")
        end = html.index("</table>", start)
        tuple_table = html[start:end]
        assert tuple_table.count("<td>") == 1
        assert "<td>only_image.png</td>" in tuple_table

    def test_flux_redux_image_influence_shown_in_weight_column(self):
        """Flux Redux reference images don't carry a numeric weight — they
        use an ``imageInfluence`` categorical like "Medium". That value
        should surface in the weight column when no numeric weight exists.
        """
        metadata = {
            "metadata_version": 5,
            "app_version": "5.6.0",
            "positive_prompt": "x",
            "seed": 1,
            "model": {"name": "m"},
            "ref_images": [
                {
                    "id": "r1",
                    "isEnabled": True,
                    "config": {
                        "type": "ipAdapter",
                        "model": {"name": "flux_redux"},
                        "image": {"image_name": "redux.png"},
                        "imageInfluence": "Medium",
                        # no numeric weight
                    },
                }
            ],
        }
        html = format_invoke_metadata(_slide(), metadata).description
        start = html.index("<table class='invoke-tuples'>")
        end = html.index("</table>", start)
        tuple_table = html[start:end]
        assert "<td>Medium</td>" in tuple_table
        # And the formatter must NOT have replaced "Medium" with 1.0
        assert "<td>1.0</td>" not in tuple_table

    def test_flux_redux_image_influence_v3_ip_adapters(self):
        """Same fallback applies to v3-style ipAdapters entries."""
        metadata = {
            "metadata_version": 3,
            "app_version": "3.5.0",
            "positive_prompt": "x",
            "seed": 1,
            "model": {"model_name": "m"},
            "ipAdapters": [
                {
                    "ip_adapter_model": {"model_name": "flux_redux"},
                    "image": {"image_name": "redux.png"},
                    "imageInfluence": "High",
                    # no numeric weight
                }
            ],
        }
        html = format_invoke_metadata(_slide(), metadata).description
        assert "<td>High</td>" in html
        assert "flux_redux" in html

    def test_numeric_weight_wins_over_image_influence(self):
        """When both weight and imageInfluence are present, the numeric
        weight takes precedence — it's the more specific signal.
        """
        metadata = {
            "metadata_version": 5,
            "app_version": "5.6.0",
            "positive_prompt": "x",
            "seed": 1,
            "model": {"name": "m"},
            "ref_images": [
                {
                    "id": "r1",
                    "isEnabled": True,
                    "config": {
                        "type": "ipAdapter",
                        "model": {"name": "ipa"},
                        "image": {"image_name": "ref.png"},
                        "weight": 0.6,
                        "imageInfluence": "Medium",
                    },
                }
            ],
        }
        html = format_invoke_metadata(_slide(), metadata).description
        assert "<td>0.6</td>" in html
        assert "Medium" not in html

    def test_mixed_weight_column_leaves_missing_weights_blank(self):
        """When some IP-adapter refs carry an explicit weight and others do
        not, the column survives (one row has data) and rows without a
        weight render as an empty cell rather than a synthesized 1.0.
        """
        metadata = {
            "metadata_version": 5,
            "app_version": "5.6.0",
            "positive_prompt": "x",
            "seed": 1,
            "model": {"name": "m"},
            "ref_images": [
                {
                    "id": "r1",
                    "isEnabled": True,
                    "config": {
                        "type": "ipAdapter",
                        "model": {"name": "ipa"},
                        "image": {"image_name": "first.png"},
                        # no weight — column survives, this cell stays empty
                    },
                },
                {
                    "id": "r2",
                    "isEnabled": True,
                    "config": {
                        "type": "ipAdapter",
                        "model": {"name": "ipa"},
                        "image": {"image_name": "second.png"},
                        "weight": 0.7,
                    },
                },
            ],
        }
        html = format_invoke_metadata(_slide(), metadata).description
        start = html.index("<table class='invoke-tuples'>")
        end = html.index("</table>", start)
        tuple_table = html[start:end]
        # All three columns survive (model, image, weight) × 2 rows → 6 <td>s.
        assert tuple_table.count("<tr>") == 2
        assert tuple_table.count("<td>") == 6
        assert "<td>first.png</td>" in tuple_table
        assert "<td>second.png</td>" in tuple_table
        # First row has an empty weight cell — no synthesized 1.0.
        assert "<td>0.7</td>" in tuple_table
        assert "<td>1.0</td>" not in tuple_table
        assert "<td></td>" in tuple_table

    def test_refs_without_ip_adapter_suppress_weight_column(self):
        """Reference images that attach directly to the model (Flux2, Qwen,
        etc.) have no IP adapter — ``cfg.model`` is None — and any weight
        InvokeAI serializes for them is an internal default, not a user
        value. The column should drop entirely so a stray serialized 1.0
        on one row doesn't make the user think the other ref has no weight
        while this one does.
        """
        metadata = {
            "metadata_version": 5,
            "app_version": "6.12.0",
            "positive_prompt": "x",
            "seed": 1,
            "model": {"name": "m"},
            "ref_images": [
                {
                    "id": "r1",
                    "isEnabled": True,
                    "config": {
                        "type": "flux2_reference_image",
                        "image": {"image_name": "first.png"},
                        # no weight at all
                    },
                },
                {
                    "id": "r2",
                    "isEnabled": True,
                    "config": {
                        "type": "flux2_reference_image",
                        "image": {"image_name": "second.png"},
                        "model": None,
                        "weight": 1,  # serialized internal default
                    },
                },
            ],
        }
        html = format_invoke_metadata(_slide(), metadata).description
        start = html.index("<table class='invoke-tuples'>")
        end = html.index("</table>", start)
        tuple_table = html[start:end]
        # Only the image-name column survives → 1 cell per row.
        assert tuple_table.count("<tr>") == 2
        assert tuple_table.count("<td>") == 2
        assert "<td>first.png</td>" in tuple_table
        assert "<td>second.png</td>" in tuple_table
        assert "1" not in tuple_table.replace("first.png", "").replace("second.png", "")

    def test_ref_images_list_of_lists_is_flattened(self):
        """Some legacy metadata wraps ref_images in an outer list. The v5
        model validator should flatten it before parsing.
        """
        metadata = {
            "metadata_version": 5,
            "app_version": "5.6.0",
            "positive_prompt": "x",
            "seed": 1,
            "model": {"name": "m"},
            "ref_images": [
                [
                    {
                        "id": "r1",
                        "isEnabled": True,
                        "config": {
                            "type": "ipAdapter",
                            "model": {"name": "ipa"},
                            "image": {"image_name": "nested.png"},
                            "weight": 0.5,
                        },
                    },
                ]
            ],
        }
        html = format_invoke_metadata(_slide(), metadata).description
        assert "nested.png" in html
        assert "ipa" in html

    def test_ref_images_unwrap_nested_original_image(self):
        """Old metadata may nest the image under ``config.image.original.image``.
        The v5 validator should collapse that to ``config.image`` before parsing.
        """
        metadata = {
            "metadata_version": 5,
            "app_version": "5.6.0",
            "positive_prompt": "x",
            "seed": 1,
            "model": {"name": "m"},
            "ref_images": [
                {
                    "id": "r1",
                    "isEnabled": True,
                    "config": {
                        "type": "ipAdapter",
                        "model": {"name": "ipa"},
                        "image": {
                            "original": {"image": {"image_name": "deep.png"}}
                        },
                        "weight": 0.5,
                    },
                }
            ],
        }
        html = format_invoke_metadata(_slide(), metadata).description
        assert "deep.png" in html

    def test_control_layer_row_skipped_when_fully_empty(self):
        """A row with every cell empty should be dropped from the tuple table."""
        metadata = {
            "metadata_version": 5,
            "app_version": "5.6.0",
            "positive_prompt": "x",
            "seed": 1,
            "model": {"name": "m"},
            "control_layers": {
                "version": 1,
                "layers": [
                    {
                        "id": "cl1",
                        "type": "control_layer",
                        "isEnabled": True,
                        "isSelected": False,
                        "ipAdapter": {
                            # model name empty, image name empty, no weight
                            "model": {"name": ""},
                            "image": {"image_name": ""},
                        },
                    },
                    {
                        "id": "cl2",
                        "type": "control_layer",
                        "isEnabled": True,
                        "isSelected": False,
                        "ipAdapter": {
                            "model": {"name": "canny"},
                            "image": {"image_name": "e.png"},
                            "weight": 0.5,
                        },
                    },
                ],
            },
        }
        html = format_invoke_metadata(_slide(), metadata).description
        # The inner tuple table should contain exactly one <tr> — the
        # "all empty" layer is dropped and only the "canny" layer survives.
        start = html.index("<table class='invoke-tuples'>")
        end = html.index("</table>", start)
        tuple_table = html[start:end]
        assert tuple_table.count("<tr>") == 1
        assert "canny" in tuple_table
        assert "e.png" in tuple_table


# ---------------------------------------------------------------------------
# InvokeMetadataView.to_recall_payload — serialization for /api/v1/recall
# ---------------------------------------------------------------------------


class TestRecallPayload:
    def test_v3_includes_core_fields_loras_controls_ip_adapters(self, v3_metadata):
        payload = _view(v3_metadata).to_recall_payload(include_seed=True)
        assert payload["positive_prompt"] == "a cat riding a skateboard"
        assert payload["negative_prompt"] == "blurry, low quality"
        assert payload["model"] == "dreamshaper"
        assert payload["seed"] == 42
        assert payload["loras"] == [
            {"model_name": "detail_lora", "weight": 0.8},
            {"model_name": "style_lora", "weight": 0.5},
        ]
        assert payload["ip_adapters"] == [
            {"model_name": "ip_adapter_sd15", "image_name": "ref.png", "weight": 0.5}
        ]
        assert payload["control_layers"] == [
            {
                "model_name": "canny_sd15",
                "image_name": "control.png",
                "weight": 0.7,
            }
        ]

    def test_remix_omits_seed(self, v3_metadata):
        payload = _view(v3_metadata).to_recall_payload(include_seed=False)
        assert "seed" not in payload
        # Everything else still present
        assert payload["positive_prompt"] == "a cat riding a skateboard"
        assert payload["loras"]

    def test_v5_ref_images_path(self, v5_ref_images_metadata):
        payload = _view(v5_ref_images_metadata).to_recall_payload(include_seed=True)
        assert payload["positive_prompt"] == "a dog in a hat"
        assert payload["model"] == "flux-schnell"
        assert payload["seed"] == 100
        # disabled ref images and disabled control layers are filtered out
        assert payload["ip_adapters"] == [
            {"model_name": "ipa-flux", "image_name": "ref1.png", "weight": 0.7}
        ]
        assert payload["control_layers"] == [
            {"model_name": "canny_flux", "image_name": "edges.png", "weight": 0.9}
        ]

    def test_empty_metadata_returns_empty_payload(self):
        # Build a view over a near-empty v5 record so that to_recall_payload
        # still exercises the "omit None" branches.
        metadata = {"metadata_version": 5}
        view = _view(metadata)
        payload = view.to_recall_payload(include_seed=True)
        assert payload == {}


# ---------------------------------------------------------------------------
# format_invoke_metadata — recall button rendering
# ---------------------------------------------------------------------------


class TestFormatInvokeRecallButtons:
    def test_buttons_hidden_by_default(self, v3_metadata):
        html = format_invoke_metadata(_slide(), v3_metadata).description
        assert "invoke-recall-controls" not in html

    def test_buttons_shown_when_enabled(self, v3_metadata):
        html = format_invoke_metadata(
            _slide(), v3_metadata, show_recall_buttons=True
        ).description
        assert 'class="invoke-recall-controls"' in html
        assert 'data-recall-mode="recall"' in html
        assert 'data-recall-mode="remix"' in html
        assert 'data-recall-mode="use_ref"' in html
        assert 'data-recall-mode="append_ref"' in html
        assert 'class="invoke-recall-heading">InvokeAI</th>' in html
        assert "Send Image" in html
        assert "Append Image" in html
        assert html.count('class="invoke-recall-btn"') == 4

    def test_scalar_only_metadata_appends_use_ref_button_when_enabled(self):
        """A flat-scalars custom-workflow image carries no recallable
        parameters, but the image itself can still be uploaded as a reference.
        """
        metadata = {"Custom Field": "value", "Steps": 20}
        html = format_invoke_metadata(
            _slide(), metadata, show_recall_buttons=True
        ).description
        assert 'data-recall-mode="use_ref"' in html
        assert 'data-recall-mode="append_ref"' in html
        # Recall and Remix make no sense without parsed parameters.
        assert 'data-recall-mode="recall"' not in html
        assert 'data-recall-mode="remix"' not in html
        assert html.count('class="invoke-recall-btn"') == 2

    def test_scalar_only_metadata_no_buttons_when_disabled(self):
        metadata = {"Custom Field": "value"}
        html = format_invoke_metadata(_slide(), metadata).description
        assert "invoke-recall-controls" not in html

    def test_unknown_invoke_format_appends_use_ref_button_when_enabled(self):
        """Payloads that look like Invoke metadata but fail discriminator
        validation should still expose the Use-as-Ref button (the file on
        disk is fine even if its metadata makes no sense).
        """
        # ``metadata_version: 99`` is not a known discriminator, so parsing
        # raises ValidationError. The fallback used to render an opaque
        # "Unknown invoke metadata format" placeholder; it now extracts
        # whichever top-level scalar fields are present and renders them
        # via ``_scalar_table`` so the user still sees the seed / model /
        # prompt etc. they care about.
        metadata = {
            "metadata_version": 99,
            "app_version": "9.9.9",
            "model": {"wat": "not a recognizable model"},
        }
        html = format_invoke_metadata(
            _slide(), metadata, show_recall_buttons=True
        ).description
        # Scalar fields surface in the fallback table; the nested ``model``
        # dict is filtered out as a non-scalar.
        assert "9.9.9" in html
        assert "99" in html
        assert "<table class='invoke-metadata'>" in html
        # Recall button still appended — file on disk is fine even when the
        # metadata is unparseable.
        assert 'data-recall-mode="use_ref"' in html
        assert 'data-recall-mode="recall"' not in html
        assert 'data-recall-mode="remix"' not in html

    def test_unparseable_with_no_scalars_falls_back_to_placeholder(self):
        """If the unparseable payload has *no* scalar top-level fields, the
        placeholder remains the only sensible output. (No ``metadata_version``
        here — that would itself be a scalar and trip the scalar-table
        branch above.)"""
        metadata = {
            "model": {"wat": "nope"},
            "nested_only": {"a": 1},
        }
        html = format_invoke_metadata(
            _slide(), metadata, show_recall_buttons=True
        ).description
        assert "Unknown invoke metadata format" in html
        # Use-as-ref button still appended.
        assert 'data-recall-mode="use_ref"' in html

    def test_use_ref_button_html_renders_send_and_append_buttons(self):
        html = use_ref_button_html()
        assert 'class="invoke-recall-controls"' in html
        assert 'data-recall-mode="use_ref"' in html
        assert 'data-recall-mode="append_ref"' in html
        assert 'class="invoke-recall-heading">InvokeAI</th>' in html
        assert "Send Image" in html
        assert "Append Image" in html
        assert html.count('class="invoke-recall-btn"') == 2


# ---------------------------------------------------------------------------
# InvokeAI 7 records: the ``metadata_version`` collision
# ---------------------------------------------------------------------------


class TestRecordVersionCollision:
    """``metadata_version`` means two different things, and they collided.

    To PhotoMapAI it has always been the tag selecting v2 / v3 / v5, and it
    is synthesised at parse time because InvokeAI never wrote it. InvokeAI 7
    started writing it — as a semver string naming the *record's* version.
    Left alone, every image and video that release produces reaches the
    discriminated union tagged ``"1.0.0"``, matches no member and degrades
    to the formatter's flat scalar table, which is a regression for images
    quite apart from the video work that surfaced it.
    """

    def test_a_semver_record_version_still_parses(self):
        parsed = GenerationMetadataAdapter().parse(
            {
                "metadata_version": "1.0.0",
                "app_version": "7.0.0",
                "positive_prompt": "a lighthouse",
                "seed": 7,
            }
        )

        assert parsed.metadata_version == 5
        assert InvokeMetadataView(parsed).seed == 7

    def test_the_record_version_is_preserved_not_discarded(self):
        parsed = GenerationMetadataAdapter().parse(
            {"metadata_version": "1.0.0", "app_version": "7.0.0"}
        )

        assert parsed.invoke_record_version == "1.0.0"

    def test_a_record_version_does_not_trip_the_unknown_field_warning(self, caplog):
        """It is a declared field, so schema-drift logging stays meaningful."""
        with caplog.at_level("WARNING"):
            GenerationMetadataAdapter().parse(
                {"metadata_version": "9.9.9", "app_version": "9.0.0", "seed": 1}
            )

        assert "invoke_record_version" not in caplog.text

    def test_our_own_integer_tag_is_still_honoured(self):
        """A payload we already tagged must not be re-inferred."""
        parsed = GenerationMetadataAdapter().parse(
            {"metadata_version": 3, "app_version": "7.0.0", "seed": 1}
        )

        assert parsed.metadata_version == 3

    def test_a_float_tag_is_not_mistaken_for_our_integer_one(self):
        """``5.0 in (2, 3, 5)`` is True but the union rejects a float."""
        parsed = GenerationMetadataAdapter().parse(
            {"metadata_version": 5.0, "app_version": "7.0.0", "seed": 1}
        )

        assert parsed.metadata_version == 5
        assert parsed.invoke_record_version == "5.0"

    def test_an_unrecognised_integer_tag_is_re_inferred_rather_than_failing(self):
        """A future InvokeAI record tag must not take the drawer down."""
        parsed = GenerationMetadataAdapter().parse(
            {"metadata_version": 11, "app_version": "8.1.0", "seed": 1}
        )

        assert parsed.metadata_version == 5

    def test_a_record_version_is_dropped_when_the_payload_reads_as_v2_or_v3(self):
        """v2 and v3 forbid extra fields, and no release read as one ever
        stamped a record version — injecting the key there would turn a
        parse that works today into a failure."""
        parsed = GenerationMetadataAdapter().parse(
            {"metadata_version": "1.0.0", "app_version": "3.4.0", "seed": 1}
        )

        assert parsed.metadata_version == 3


# ---------------------------------------------------------------------------
# The video profile
# ---------------------------------------------------------------------------


def _video_record(**overrides) -> dict:
    """A Wan image-to-video record as InvokeAI 7 writes it."""
    record = {
        "metadata_version": "1.0.0",
        "app_version": "7.0.0",
        "generation_mode": "wan_i2v",
        "positive_prompt": "a paper boat",
        "seed": 99,
        "steps": 30,
        "width": 832,
        "height": 480,
        "num_frames": 81,
        "fps": 16,
        "first_frame_image": {"image_name": "first.png"},
        "model": {"name": "Wan 2.2 I2V A14B", "base": "wan", "type": "main"},
    }
    record.update(overrides)
    return record


def _video_view(**overrides) -> InvokeMetadataView:
    return InvokeMetadataView(GenerationMetadataAdapter().parse(_video_record(**overrides)))


class TestVideoProfile:
    def test_a_video_record_is_recognised_as_one(self):
        assert _video_view().is_video_generation is True

    def test_an_image_record_is_not(self):
        view = InvokeMetadataView(
            GenerationMetadataAdapter().parse(
                {
                    "metadata_version": "1.0.0",
                    "app_version": "7.0.0",
                    "generation_mode": "txt2img",
                    "positive_prompt": "a lighthouse",
                }
            )
        )

        assert view.is_video_generation is False

    def test_an_image_record_renders_no_mode_row(self):
        """``generation_mode`` is shared with images, so it cannot be what
        decides that a video block is due — otherwise every image grows a
        row it never had."""
        html = format_invoke_metadata(
            _slide(), {"app_version": "7.0.0", "generation_mode": "txt2img"}
        ).description

        assert "<th>Mode</th>" not in html

    def test_the_shared_fields_still_read_the_same_as_an_image(self):
        view = _video_view()

        assert view.positive_prompt == "a paper boat"
        assert view.seed == 99
        assert view.model_name == "Wan 2.2 I2V A14B"

    def test_frames_and_frame_rate_are_reported(self):
        facts = dict(_video_view().video_facts)

        assert facts["Mode"] == "wan_i2v"
        assert facts["Frames"] == "81"
        assert facts["Frame Rate"] == "16 fps"

    def test_a_fractional_frame_rate_keeps_its_fraction(self):
        facts = dict(_video_view(fps=23.976).video_facts)

        assert facts["Frame Rate"] == "23.976 fps"

    def test_absent_fields_produce_no_rows(self):
        """A text-to-video clip has no keyframes and must not show empty ones."""
        record = _video_record()
        del record["first_frame_image"]
        record["generation_mode"] = "wan_t2v"
        facts = dict(InvokeMetadataView(GenerationMetadataAdapter().parse(record)).video_facts)

        assert "First Frame" not in facts
        assert "Last Frame" not in facts
        assert "Source Video" not in facts

    def test_keyframes_are_reported_by_name(self):
        facts = dict(_video_view(last_frame_image={"image_name": "last.png"}).video_facts)

        assert facts["First Frame"] == "first.png"
        assert facts["Last Frame"] == "last.png"

    def test_a_source_clip_reports_its_trim_range(self):
        """The range is its own row, not a parenthetical on the name: the
        drawer only thumbnails a cell holding exactly a media name."""
        facts = dict(
            _video_view(
                generation_mode="wan_extend_video",
                source_video={"video_name": "clip.mp4"},
                source_video_start_frame=0,
                source_video_end_frame=80,
            ).video_facts
        )

        assert facts["Source Video"] == "clip.mp4"
        assert facts["Source Range"] == "frames 0-80"

    def test_a_source_clip_with_no_trim_range_reports_no_range_row(self):
        facts = dict(_video_view(source_video={"video_name": "clip.mp4"}).video_facts)

        assert facts["Source Video"] == "clip.mp4"
        assert "Source Range" not in facts

    def test_a_half_open_trim_range_still_reads(self):
        facts = dict(
            _video_view(
                source_video={"video_name": "clip.mp4"},
                source_video_start_frame=12,
            ).video_facts
        )

        assert facts["Source Range"] == "from frame 12"

    def test_auxiliary_models_are_reported_with_their_roles(self):
        """``model`` alone does not identify what ran when the main model is
        a single file assembled from parts living in other installs."""
        view = _video_view(
            wan_t5_encoder_model={"name": "UMT5-XXL", "type": "t5_encoder"},
            wan_transformer_low_noise={"name": "Wan Low Noise", "type": "main"},
        )

        assert view.video_models == [
            ("T5 Encoder", "UMT5-XXL"),
            ("Low-Noise Expert", "Wan Low Noise"),
        ]

    def test_pre_1_0_wan_key_spellings_are_read_as_aliases(self):
        """InvokeAI's own readers accept both spellings; so must ours."""
        view = _video_view(
            wan_t5_encoder={"name": "UMT5-XXL", "type": "t5_encoder"},
            transformer_low_noise={"name": "Wan Low Noise", "type": "main"},
            guidance_scale_low_noise=3.5,
        )

        assert view.video_models == [
            ("T5 Encoder", "UMT5-XXL"),
            ("Low-Noise Expert", "Wan Low Noise"),
        ]
        assert dict(view.video_facts)["Low-Noise CFG"] == "3.5"

    def test_minimax_references_are_reported_in_conditioning_order(self):
        view = _video_view(
            generation_mode="minimax_h3_ref2v",
            minimax_h3_references=[
                {"kind": "image", "image_name": "a.png", "detail": "max"},
                {
                    "kind": "video",
                    "video_name": "b.mp4",
                    "conditioning": "video_audio",
                    "start_frame": 0,
                    "end_frame": 48,
                },
            ],
        )

        assert view.video_references == [
            ("image", "a.png", "max"),
            ("video", "b.mp4", "video_audio, frames 0-48"),
        ]

    def test_referenced_media_is_offered_for_thumbnailing(self):
        """Keyframes and the source clip resolve by the same album-filename
        lookup as an image's reference images, so they join the same list."""
        view = _video_view(
            last_frame_image={"image_name": "last.png"},
            source_video={"video_name": "clip.mp4"},
            minimax_h3_references=[{"kind": "image", "image_name": "ref.png"}],
        )

        assert view.video_media_names == [
            "first.png",
            "last.png",
            "clip.mp4",
            "ref.png",
        ]

    def test_an_unknown_future_mode_still_renders_its_video_fields(self):
        """Detection is "has a video-only field", not "matches a known mode":
        that list grows with every architecture InvokeAI adds."""
        view = _video_view(generation_mode="hypothetical_v9_t2v")

        assert view.is_video_generation is True
        assert dict(view.video_facts)["Frames"] == "81"

    def test_the_whole_record_parses_without_unknown_field_warnings(self, caplog):
        """Every field InvokeAI 7 documents for the video profile is declared.

        ``extra="allow"`` means an undeclared field parses but is invisible
        in the drawer, so the warning is the only signal that something is
        being dropped — and it fires once per process, so a test that runs
        after another parse of the same field would not see it. Clearing the
        seen-set keeps this assertion about this payload.
        """
        from photomap.backend.metadata_modules.invoke import invoke5metadata

        invoke5metadata._warned_extra_fields.clear()
        with caplog.at_level("WARNING"):
            GenerationMetadataAdapter().parse(
                _video_record(
                    last_frame_image={"image_name": "last.png"},
                    source_video={"video_name": "clip.mp4"},
                    source_video_start_frame=0,
                    source_video_end_frame=80,
                    wan_guidance_scale_low_noise=3.5,
                    wan_t5_encoder_model={"name": "UMT5-XXL", "type": "t5_encoder"},
                    wan_transformer_low_noise={"name": "Low", "type": "main"},
                    wan_component_source={"name": "Wan Diffusers", "type": "main"},
                    minimax_h3_transformer_model={"name": "H3", "type": "main"},
                    minimax_h3_text_encoder_model={"name": "Qwen3-VL", "type": "main"},
                    minimax_h3_component_source={"name": "H3 Diffusers", "type": "main"},
                    minimax_h3_hybrid_base_model={"name": "FL2VA", "type": "main"},
                    minimax_h3_hybrid_start_block=20,
                    minimax_h3_references=[{"kind": "image", "image_name": "a.png"}],
                    media_origin="audio_upload",
                )
            )

        assert "not declared in GenerationMetadata5" not in caplog.text


class TestFormatVideoInvokeMetadata:
    def test_the_video_rows_are_rendered(self):
        html = format_invoke_metadata(_slide(), _video_record()).description

        assert "<th>Mode</th><td>wan_i2v</td>" in html
        assert "<th>Frames</th><td>81</td>" in html
        assert '<th>First Frame</th><td class="invoke-media-name">first.png' in html

    def test_the_prompt_and_seed_are_still_rendered(self):
        html = format_invoke_metadata(_slide(), _video_record()).description

        assert "a paper boat" in html
        assert ">99<" in html

    def test_referenced_media_lands_on_the_slide_for_thumbnailing(self):
        slide = format_invoke_metadata(
            _slide(), _video_record(source_video={"video_name": "clip.mp4"})
        )

        assert slide.reference_images == ["first.png", "clip.mp4"]

    def test_media_name_cells_are_marked_for_thumbnailing(self):
        """``reference-thumbnails.js`` swaps these cells for a thumbnail when
        the name resolves to something in the current album."""
        html = format_invoke_metadata(
            _slide(), _video_record(source_video={"video_name": "clip.mp4"})
        ).description

        assert '<td class="invoke-media-name">first.png</td>' in html
        assert '<td class="invoke-media-name">clip.mp4</td>' in html

    def test_non_media_cells_are_not_marked(self):
        html = format_invoke_metadata(_slide(), _video_record()).description

        assert '<th>Mode</th><td>wan_i2v</td>' in html
        assert '<th>Frames</th><td>81</td>' in html

    def test_auxiliary_models_render_as_a_role_and_name_table(self):
        html = format_invoke_metadata(
            _slide(),
            _video_record(
                wan_t5_encoder_model={"name": "UMT5-XXL", "type": "t5_encoder"}
            ),
        ).description

        assert "<th>Video Models</th>" in html
        assert "<td>T5 Encoder</td><td>UMT5-XXL</td>" in html

    def test_a_prompt_from_the_record_is_escaped(self):
        """Metadata travels inside files from anywhere; the drawer renders it."""
        html = format_invoke_metadata(
            _slide(), _video_record(generation_mode="<script>alert(1)</script>")
        ).description

        assert "<script>" not in html
        assert "&lt;script&gt;" in html


class TestVideoRecordRobustness:
    """Declaring a field turns "unknown extra, parses fine" into "the whole
    record fails validation", and a failed record costs the drawer its
    model, LoRAs and reference images too — not just the one field. These
    pin the shapes that must keep parsing.
    """

    def test_a_model_identifier_with_a_submodel_type_still_parses(self):
        """InvokeAI's ``ModelIdentifierField`` has a sixth field, dropped
        from the record only while it is None."""
        view = _video_view(
            wan_t5_encoder_model={
                "name": "UMT5-XXL",
                "base": "wan",
                "type": "t5_encoder",
                "key": "k",
                "hash": "h",
                "submodel_type": "transformer",
            }
        )

        assert view.video_models == [("T5 Encoder", "UMT5-XXL")]
        # And the rest of the record survived rather than collapsing.
        assert view.model_name == "Wan 2.2 I2V A14B"

    def test_an_absurd_frame_rate_does_not_take_the_drawer_down(self):
        """``format(10 ** 400, "g")`` raises ``OverflowError`` — not a
        ``TypeError`` and not a ``ValueError`` — and nothing between here
        and the response catches it, so it would be a 500 on
        ``/retrieve_image``: a blank slide, not a missing row. Reachable
        because the record is whatever the file said.
        """
        facts = dict(_video_view(fps=10**400).video_facts)

        assert facts["Frame Rate"].endswith(" fps")

    @pytest.mark.parametrize("fps", [float("inf"), float("nan"), "16", 0])
    def test_other_unusable_frame_rates_do_not_raise(self, fps):
        assert "Frame Rate" in dict(_video_view(fps=fps).video_facts)

    def test_an_image_record_with_an_absurd_frame_rate_also_survives(self):
        """``fps`` is a declared field now, so a *PNG* whose text chunk
        carries one reaches the same formatter."""
        html = format_invoke_metadata(
            _slide(),
            {
                "app_version": "7.0.0",
                "generation_mode": "txt2img",
                "fps": 10**400,
                "model": {"name": "SDXL", "base": "sdxl", "type": "main"},
            },
        ).description

        assert "SDXL" in html

    def test_the_canonical_wan_spelling_wins_over_the_legacy_alias(self):
        """A pydantic ``alias`` would let the legacy key win and leave the
        canonical one in ``model_extra``, where it trips the schema-drift
        warning by the name of a field that is declared right there."""
        view = _video_view(
            wan_t5_encoder={"name": "legacy", "type": "t5_encoder"},
            wan_t5_encoder_model={"name": "canonical", "type": "t5_encoder"},
        )

        assert view.video_models == [("T5 Encoder", "canonical")]

    def test_a_legacy_spelling_never_reaches_the_drift_warning(self, caplog):
        from photomap.backend.metadata_modules.invoke import invoke5metadata

        invoke5metadata._warned_extra_fields.clear()
        with caplog.at_level("WARNING"):
            GenerationMetadataAdapter().parse(
                _video_record(
                    wan_t5_encoder={"name": "legacy", "type": "t5_encoder"},
                    transformer_low_noise={"name": "low", "type": "main"},
                    guidance_scale_low_noise=3.5,
                )
            )

        assert "not declared in GenerationMetadata5" not in caplog.text


class TestInvokeMarkerAgreement:
    """``looks_like_invoke_metadata`` gates routing and
    ``_infer_metadata_version`` picks the schema. A fingerprint the second
    knows about but the first does not is a fingerprint that never fires:
    the record is sent to the EXIF renderer and never reaches the adapter.
    """

    @pytest.mark.parametrize("marker", ["num_frames", "source_video"])
    def test_a_video_fingerprint_is_also_a_routing_marker(self, marker):
        payload = {marker: 1}

        assert looks_like_invoke_metadata(payload) is True
        assert GenerationMetadataAdapter._infer_metadata_version(payload) == 5

    def test_a_marker_less_record_is_still_not_claimed(self):
        assert looks_like_invoke_metadata({"Make": "Pixel"}) is False
        assert looks_like_invoke_metadata({}) is False
        assert looks_like_invoke_metadata(None) is False
