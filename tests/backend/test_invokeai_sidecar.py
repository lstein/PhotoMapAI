"""The JSON sidecar fallback for videos generated before InvokeAI 7.

Two things are under test and they fail differently. The *path derivation*
has to find a sidecar that is really there, from nothing but the video's
absolute path — PhotoMapAI never learns where an ``outputs`` directory
begins. The *reader* has to come back empty rather than raise for everything
else on a user's disk, because it runs once per video over whole
collections.

The fixtures mirror the layout measured on a real install:

    <root>/general/<stem>.mp4
    <root>/sidecars/general/<stem>.json

with `invokeai_metadata` a *stringified* JSON document or ``null``. In that
install 530 of 662 sidecars carried null and 132 a real record, so "exists
but has nothing for us" is the ordinary case rather than an error.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from fixtures import media_fixture_path

from photomap.backend import invokeai_sidecar
from photomap.backend.invokeai_sidecar import (
    read_sidecar_metadata,
    sidecar_candidates,
)
from photomap.backend.metadata_extraction import MetadataExtractor

RECORD = {
    "app_version": "6.14.0-alpha",
    "generation_mode": "minimax_h3_extend_video",
    "positive_prompt": "a paper boat",
    "seed": 11,
    "num_frames": 97,
    "model": {"name": "MiniMax H3", "base": "minimax", "type": "main"},
}


def write_sidecar(path, record=RECORD, workflow='{"name":"w"}'):
    """A sidecar in InvokeAI's shape: the record *stringified*, or null."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "invokeai_metadata": None if record is None else json.dumps(record),
                "invokeai_workflow": workflow,
                "invokeai_graph": None,
            }
        ),
        encoding="utf-8",
    )
    return path


@pytest.fixture
def invoke_outputs(tmp_path):
    """``<root>/general/clip.mp4`` with a real, untagged MP4 — the layout a
    pre-7 install actually has."""
    root = tmp_path / "videos"
    video = root / "general" / "clip.mp4"
    video.parent.mkdir(parents=True)
    shutil.copy(media_fixture_path("clip.mp4"), video)
    return root, video


# --------------------------------------------------------------------------
# Path derivation
# --------------------------------------------------------------------------


def test_the_category_layout_is_the_second_candidate(tmp_path):
    """Depth 1 is where every sidecar in the sampled install lives."""
    video = tmp_path / "videos" / "general" / "abc.mp4"

    candidates = list(sidecar_candidates(video))

    assert candidates[0] == tmp_path / "videos" / "general" / "sidecars" / "abc.json"
    assert candidates[1] == tmp_path / "videos" / "sidecars" / "general" / "abc.json"


def test_a_videos_root_with_no_subfolder_is_the_first_candidate(tmp_path):
    video = tmp_path / "videos" / "abc.mp4"

    assert next(sidecar_candidates(video)) == (
        tmp_path / "videos" / "sidecars" / "abc.json"
    )


def test_the_walk_stops_above_the_videos_root(tmp_path):
    """Pinned by value, not by ``MAX_SUBFOLDER_DEPTH``.

    Asserting against the constant the loop uses proves only that the loop
    uses it: the old form of this test passed with the bound set to 1 and
    equally with it set to 9. What matters is the *reach* — every extra
    level is a file opened outside the album the user configured, and at
    depth 3 that is a path at the filesystem root.
    """
    video = tmp_path / "a" / "b" / "c" / "d" / "e" / "clip.mp4"

    candidates = list(sidecar_candidates(video))

    assert candidates == [
        tmp_path / "a/b/c/d/e" / "sidecars" / "clip.json",
        tmp_path / "a/b/c/d" / "sidecars" / "e" / "clip.json",
    ]


def test_a_sidecar_two_levels_up_is_out_of_reach(tmp_path):
    """The bound is real, and this is the file it declines to open."""
    video = tmp_path / "videos" / "general" / "clip.mp4"
    video.parent.mkdir(parents=True)
    video.touch()
    write_sidecar(tmp_path / "sidecars" / "videos" / "general" / "clip.json")

    assert read_sidecar_metadata(video) == {}


def test_a_shallow_path_stops_at_the_filesystem_root():
    """Fewer ancestors than the depth limit must not raise."""
    candidates = list(sidecar_candidates(Path("/clip.mp4")))

    assert candidates == [Path("/sidecars/clip.json")]


def test_the_extension_is_replaced_not_appended(tmp_path):
    video = tmp_path / "videos" / "general" / "clip.mov"

    assert all(c.name == "clip.json" for c in sidecar_candidates(video))


# --------------------------------------------------------------------------
# Reading
# --------------------------------------------------------------------------


def test_reads_a_record_from_the_category_layout(invoke_outputs):
    root, video = invoke_outputs
    write_sidecar(root / "sidecars" / "general" / "clip.json")

    assert read_sidecar_metadata(video)["generation_mode"] == (
        "minimax_h3_extend_video"
    )


def test_reads_a_record_from_a_flat_videos_root(tmp_path):
    video = tmp_path / "videos" / "clip.mp4"
    video.parent.mkdir(parents=True)
    video.touch()
    write_sidecar(tmp_path / "videos" / "sidecars" / "clip.json")

    assert read_sidecar_metadata(video)["seed"] == 11


def test_a_null_record_yields_nothing(invoke_outputs):
    """The majority case: a workflow was saved but no record."""
    root, video = invoke_outputs
    write_sidecar(root / "sidecars" / "general" / "clip.json", record=None)

    assert read_sidecar_metadata(video) == {}


def test_no_sidecar_at_all_yields_nothing(invoke_outputs):
    _root, video = invoke_outputs

    assert read_sidecar_metadata(video) == {}


def test_a_sidecar_for_a_different_video_is_not_used(invoke_outputs):
    root, video = invoke_outputs
    write_sidecar(root / "sidecars" / "general" / "other.json")

    assert read_sidecar_metadata(video) == {}


def test_a_sidecar_under_the_wrong_subfolder_is_not_used(invoke_outputs):
    """The mirror has to be exact, or an ``intermediate`` record could be
    served for a ``general`` video of the same name."""
    root, video = invoke_outputs
    write_sidecar(root / "sidecars" / "intermediate" / "clip.json")

    assert read_sidecar_metadata(video) == {}


def test_a_json_file_that_is_not_an_invokeai_sidecar_is_ignored(invoke_outputs):
    """A directory named ``sidecars`` need not be InvokeAI's."""
    root, video = invoke_outputs
    path = root / "sidecars" / "general" / "clip.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"camera": "Pixel", "iso": 400}), encoding="utf-8")

    assert read_sidecar_metadata(video) == {}


def test_a_record_under_a_different_key_is_not_accepted(invoke_outputs):
    """Pins the key gate itself.

    The test above passes without any key check at all, because its payload
    has no dict record under *any* key — it is rejected further down. This
    one puts a perfectly good-looking record under the wrong key, so only
    the gate can reject it.
    """
    root, video = invoke_outputs
    path = root / "sidecars" / "general" / "clip.json"
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps({"metadata": {"positive_prompt": "x", "app_version": "6.0.0"}}),
        encoding="utf-8",
    )

    assert read_sidecar_metadata(video) == {}


def test_a_record_that_does_not_look_like_invokeais_is_rejected(invoke_outputs):
    """The key alone is a weak gate — it would hand back whatever object
    another tool happened to store under that name."""
    root, video = invoke_outputs
    path = root / "sidecars" / "general" / "clip.json"
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps({"invokeai_metadata": {"anything": "at all"}}), encoding="utf-8"
    )

    assert read_sidecar_metadata(video) == {}


def test_every_shape_of_real_record_still_passes_the_gate(invoke_outputs):
    """The gate must not reject the records it exists to admit. These are
    the marker keys the sampled pre-7 records actually carry."""
    root, video = invoke_outputs
    path = root / "sidecars" / "general" / "clip.json"
    for marker in ("app_version", "generation_mode", "num_frames"):
        write_sidecar(path, record={marker: "6.14.0" if marker == "app_version" else 1})
        assert read_sidecar_metadata(video), marker


def test_deeply_nested_json_does_not_drop_the_video_from_the_index(invoke_outputs):
    """``RecursionError`` is a ``RuntimeError``, so neither ``except OSError``
    nor ``except ValueError`` catches it.

    Escaping here is worse than losing the metadata: ``_load_video`` catches
    it, returns None, and the video is recorded as a bad file and left out
    of the album. ~120 KB of brackets, far under the size cap.
    """
    root, video = invoke_outputs
    path = root / "sidecars" / "general" / "clip.json"
    path.parent.mkdir(parents=True)
    path.write_text(
        '{"invokeai_metadata": ' + "[" * 60000 + "]" * 60000 + "}", encoding="utf-8"
    )

    assert read_sidecar_metadata(video) == {}
    assert MetadataExtractor.extract_video_metadata(video) == {}


def test_deep_nesting_inside_the_stringified_record_is_also_caught(invoke_outputs):
    """The inner ``json.loads`` is a second, separate exposure."""
    root, video = invoke_outputs
    path = root / "sidecars" / "general" / "clip.json"
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps({"invokeai_metadata": "[" * 60000 + "]" * 60000}), encoding="utf-8"
    )

    assert read_sidecar_metadata(video) == {}


def test_candidates_inherit_a_dot_dot_from_an_unresolved_path(tmp_path):
    """Pins the precondition ``sidecar_candidates`` documents.

    It is pure and does no I/O, so a ``..`` in the input survives into the
    candidate and the *kernel* resolves it at open time — which can land
    outside any ``sidecars`` directory. That is why the reader resolves
    before calling it, and this is the behaviour that makes it necessary.
    """
    candidates = list(sidecar_candidates(Path("/a/b/../c/clip.mp4")))

    assert ".." in str(candidates[0])


def test_the_reader_resolves_the_video_path_first(tmp_path):
    """A symlinked video must find the sidecar next to its *target*.

    Without resolution the lookup uses the link's own name and directory,
    so a collection that symlinks InvokeAI output in finds nothing.
    """
    root = tmp_path / "videos"
    real = root / "general" / "real.mp4"
    real.parent.mkdir(parents=True)
    shutil.copy(media_fixture_path("clip.mp4"), real)
    write_sidecar(root / "sidecars" / "general" / "real.json")

    album = tmp_path / "album"
    album.mkdir()
    link = album / "link.mp4"
    link.symlink_to(real)

    assert read_sidecar_metadata(link)["seed"] == 11


@pytest.mark.parametrize(
    "content", ["{not json", "[]", '"a string"', "null", ""]
)
def test_malformed_or_non_object_sidecars_yield_nothing(invoke_outputs, content):
    root, video = invoke_outputs
    path = root / "sidecars" / "general" / "clip.json"
    path.parent.mkdir(parents=True)
    path.write_text(content, encoding="utf-8")

    assert read_sidecar_metadata(video) == {}


def test_a_record_that_is_not_an_object_yields_nothing(invoke_outputs):
    root, video = invoke_outputs
    path = root / "sidecars" / "general" / "clip.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"invokeai_metadata": "[1,2,3]"}), encoding="utf-8")

    assert read_sidecar_metadata(video) == {}


def test_a_record_stored_unstringified_is_still_read(invoke_outputs):
    """InvokeAI always stringifies it, but discarding a perfectly good
    record over its encoding would be gratuitous."""
    root, video = invoke_outputs
    path = root / "sidecars" / "general" / "clip.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"invokeai_metadata": RECORD}), encoding="utf-8")

    assert read_sidecar_metadata(video)["seed"] == 11


def test_an_oversized_sidecar_is_not_read(invoke_outputs, monkeypatch):
    """A sidecar must be read whole to be parsed, unlike the MP4 walk."""
    monkeypatch.setattr(invokeai_sidecar, "MAX_SIDECAR_BYTES", 16)
    root, video = invoke_outputs
    write_sidecar(root / "sidecars" / "general" / "clip.json")

    assert read_sidecar_metadata(video) == {}


def test_a_directory_where_the_sidecar_would_be_is_ignored(invoke_outputs):
    root, video = invoke_outputs
    (root / "sidecars" / "general" / "clip.json").mkdir(parents=True)

    assert read_sidecar_metadata(video) == {}


def test_a_useless_near_candidate_does_not_end_the_search(invoke_outputs):
    """A null sidecar at depth 0 must not mask a real one at depth 1."""
    root, video = invoke_outputs
    write_sidecar(root / "general" / "sidecars" / "clip.json", record=None)
    write_sidecar(root / "sidecars" / "general" / "clip.json")

    assert read_sidecar_metadata(video)["seed"] == 11


# --------------------------------------------------------------------------
# Precedence, through the extractor
# --------------------------------------------------------------------------


def test_the_sidecar_is_used_when_the_mp4_carries_nothing(invoke_outputs):
    root, video = invoke_outputs
    write_sidecar(root / "sidecars" / "general" / "clip.json")

    assert MetadataExtractor.extract_video_metadata(video)["seed"] == 11


def test_embedded_metadata_wins_over_a_sidecar(tmp_path):
    """InvokeAI 7 still writes a sidecar when its remux fails, so both can
    exist; the file's own copy is the newer one."""
    root = tmp_path / "videos"
    video = root / "general" / "invoke_video.mp4"
    video.parent.mkdir(parents=True)
    shutil.copy(media_fixture_path("invoke_video.mp4"), video)
    write_sidecar(root / "sidecars" / "general" / "invoke_video.json")

    record = MetadataExtractor.extract_video_metadata(video)

    assert record["generation_mode"] == "wan_i2v"
    assert record["seed"] == 1234567


def test_a_tagged_video_never_looks_for_a_sidecar(tmp_path, monkeypatch):
    """The fallback must cost an InvokeAI 7 video nothing."""
    video = tmp_path / "invoke_video.mp4"
    shutil.copy(media_fixture_path("invoke_video.mp4"), video)

    called = []
    monkeypatch.setattr(
        "photomap.backend.metadata_extraction.read_sidecar_metadata",
        lambda path: called.append(path) or {},
    )

    assert MetadataExtractor.extract_video_metadata(video)
    assert called == []


def test_an_empty_embedded_record_falls_through_to_the_sidecar(tmp_path, monkeypatch):
    """Precedence is on the record, not the source.

    "The MP4 has no tag" and "the MP4's tag is an empty object" are worth
    the same, and the sidecar may still have something to show. Pinned
    because the ``or`` that implements it cannot tell the two apart, so the
    behaviour is easy to change by accident.
    """
    root = tmp_path / "videos"
    video = root / "general" / "clip.mp4"
    video.parent.mkdir(parents=True)
    shutil.copy(media_fixture_path("clip.mp4"), video)
    write_sidecar(root / "sidecars" / "general" / "clip.json")
    monkeypatch.setattr(
        "photomap.backend.metadata_extraction.read_mp4_tags",
        lambda path, keys=None: {"invokeai_metadata": "{}"},
    )

    assert MetadataExtractor.extract_video_metadata(video)["seed"] == 11
