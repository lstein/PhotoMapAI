"""Tests for the top-level metadata-formatting dispatcher.

The interesting cases here aren't the renderers themselves (those are covered
in ``test_invoke_metadata.py``) but the orchestration: deciding which renderer
to call and conditionally appending the standalone "Use as Ref Image" button
to the non-Invoke paths whenever an InvokeAI backend is configured.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from photomap.backend.config import get_config_manager
from photomap.backend.metadata_formatting import format_metadata


@pytest.fixture
def clear_invokeai_config():
    manager = get_config_manager()
    manager.set_invokeai_settings(url=None, username=None, password=None)
    yield
    manager.set_invokeai_settings(url=None, username=None, password=None)


@pytest.fixture
def with_invokeai_url(clear_invokeai_config):
    manager = get_config_manager()
    manager.set_invokeai_settings(url="http://localhost:9090")
    yield "http://localhost:9090"
    manager.set_invokeai_settings(url=None, username=None, password=None)


def _filepath() -> Path:
    return Path("/tmp/example.png")


class TestNoMetadata:
    def test_renders_placeholder_without_invokeai(self, clear_invokeai_config):
        result = format_metadata(_filepath(), {}, 0, 1)
        assert "No metadata available" in result.description
        assert "invoke-recall-controls" not in result.description

    def test_appends_use_ref_button_when_invokeai_configured(self, with_invokeai_url):
        result = format_metadata(_filepath(), {}, 0, 1)
        assert "No metadata available" in result.description
        assert 'data-recall-mode="use_ref"' in result.description
        # No Recall/Remix without parameters to recall.
        assert 'data-recall-mode="recall"' not in result.description
        assert 'data-recall-mode="remix"' not in result.description


class TestExifMetadata:
    EXIF = {"Make": "Canon", "Model": "EOS R5", "FNumber": 2.8}

    def test_no_button_without_invokeai(self, clear_invokeai_config):
        result = format_metadata(_filepath(), self.EXIF, 0, 1)
        assert "Canon" in result.description
        assert "invoke-recall-controls" not in result.description

    def test_use_ref_button_added_when_invokeai_configured(self, with_invokeai_url):
        result = format_metadata(_filepath(), self.EXIF, 0, 1)
        assert "Canon" in result.description
        assert 'data-recall-mode="use_ref"' in result.description
        assert 'data-recall-mode="recall"' not in result.description
        assert 'data-recall-mode="remix"' not in result.description


class TestInvokeMetadata:
    INVOKE = {
        "metadata_version": 3,
        "app_version": "3.5.0",
        "positive_prompt": "anything",
        "seed": 1,
        "model": {"model_name": "m"},
    }

    def test_no_buttons_without_invokeai(self, clear_invokeai_config):
        result = format_metadata(_filepath(), self.INVOKE, 0, 1)
        assert "anything" in result.description
        assert "invoke-recall-controls" not in result.description

    def test_full_recall_group_when_invokeai_configured(self, with_invokeai_url):
        result = format_metadata(_filepath(), self.INVOKE, 0, 1)
        assert 'data-recall-mode="recall"' in result.description
        assert 'data-recall-mode="remix"' in result.description
        assert 'data-recall-mode="use_ref"' in result.description
        # The use_ref button should be inside the same control group as the
        # recall buttons (one container, three buttons), not a duplicate
        # standalone container appended afterwards.
        assert result.description.count('class="invoke-recall-controls"') == 1
