"""The per-encoder search score floor, and the migration of stored ones.

The three bundled encoders do not share a similarity scale, so one floor
cannot filter honestly for all of them. The numbers asserted here were
measured on identical images and queries (see the table in ``encoders.py``);
what these tests protect is that each encoder family keeps *its own* number
and that albums created before the table existed are moved onto it.
"""

import sys

import numpy as np
import pytest
import yaml

from photomap.backend.config import Album, ConfigManager
from photomap.backend.encoders import (
    LEGACY_CLIP_MIN_SEARCH_SCORE,
    default_min_search_score,
)

# Windows has no POSIX permission bits: ``os.chmod`` there toggles the
# read-only flag and nothing else, so every readable file reports 0o666 and a
# "keep this config to its owner" assertion cannot mean anything. The
# behaviour under test is real on the platforms that have it — the production
# code runs the same chmod calls on Windows, they just have no user to
# exclude — so these skip rather than branching on an expected mode.
posix_modes_only = pytest.mark.skipif(
    sys.platform == "win32",
    reason="POSIX permission bits; Windows chmod only toggles read-only",
)


@pytest.mark.parametrize(
    ("spec", "expected"),
    [
        ("siglip:google/siglip2-large-patch16-256", 0.005),
        ("openai-clip:ViT-B/32", 0.2),
        ("open-clip:ViT-L-14/dfn2b_s39b", 0.1),
        # An unknown backend is far likelier to be another modern CLIP variant
        # than a copy of OpenAI's original, and erring low shows weak matches
        # rather than hiding real ones.
        ("something-new:model", 0.1),
        ("no-colon-at-all", 0.1),
    ],
)
def test_default_floor_follows_the_encoder_family(spec, expected):
    assert default_min_search_score(spec) == pytest.approx(expected)


def test_album_resolves_its_floor_from_its_encoder(tmp_path):
    """An album that never chose a floor takes its encoder's."""
    album = Album(
        key="a",
        name="A",
        image_paths=[str(tmp_path)],
        index=str(tmp_path / "i.npz"),
        encoder_spec="open-clip:ViT-L-14/dfn2b_s39b",
    )
    assert album.min_search_score == pytest.approx(0.1)


def _write_config(path, albums):
    path.write_text(
        yaml.safe_dump({"config_version": "1.0.0", "albums": albums}, indent=2)
    )


def _album_entry(tmp_path, spec, score):
    return {
        "name": "Album",
        "description": "",
        "image_paths": [str(tmp_path)],
        "index": str(tmp_path / "i.npz"),
        "umap_eps": 0.1,
        "encoder_spec": spec,
        "min_search_score": score,
    }


def test_legacy_clip_floor_is_migrated_for_openclip_albums(tmp_path):
    """The floor is stored per album, so fixing the default alone would leave
    every existing OpenCLIP album judged at a threshold above its entire match
    band — answering most searches with nothing."""
    config_path = tmp_path / "config.yaml"
    _write_config(
        config_path,
        {
            "openclip": _album_entry(
                tmp_path, "open-clip:ViT-L-14/dfn2b_s39b", LEGACY_CLIP_MIN_SEARCH_SCORE
            )
        },
    )

    manager = ConfigManager(config_path=config_path)
    assert manager.get_album("openclip").min_search_score == pytest.approx(0.1)

    # Loading is a read: the file is not rewritten behind the user's back,
    # which would drop its comments and any key this build does not know.
    assert yaml.safe_load(config_path.read_text())["albums"]["openclip"][
        "min_search_score"
    ] == pytest.approx(0.2)

    # The new value and the new stamp ride along with the next save the user
    # actually causes.
    manager.save_config()
    on_disk = yaml.safe_load(config_path.read_text())
    assert on_disk["config_version"] == "1.1.0"
    assert on_disk["albums"]["openclip"]["min_search_score"] == pytest.approx(0.1)


def test_migration_does_not_run_again_on_a_migrated_config(tmp_path):
    """0.2 has to stay a value the user can choose. Re-running the migration
    on every load would let them type it, watch it persist, and watch the next
    read quietly put it back."""
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        yaml.safe_dump(
            {
                "config_version": "1.1.0",
                "albums": {
                    "openclip": _album_entry(
                        tmp_path, "open-clip:ViT-L-14/dfn2b_s39b", 0.2
                    )
                },
            },
            indent=2,
        )
    )

    assert ConfigManager(config_path=config_path).get_album(
        "openclip"
    ).min_search_score == pytest.approx(0.2)


def test_the_migration_notice_is_printed_once_per_process(tmp_path, caplog):
    """Until a save persists it, the migration is re-applied on every load.
    Announcing it each time would read as the floor changing over and over,
    on a config that has not changed at all."""
    import logging

    from photomap.backend import config as config_module

    config_path = tmp_path / "config.yaml"
    _write_config(
        config_path,
        {
            "openclip": _album_entry(
                tmp_path, "open-clip:ViT-L-14/dfn2b_s39b", LEGACY_CLIP_MIN_SEARCH_SCORE
            )
        },
    )
    config_module._announced_score_floor_migrations.clear()

    manager = ConfigManager(config_path=config_path)
    with caplog.at_level(logging.INFO, logger="photomap.backend.config"):
        for _ in range(3):
            manager._config = None  # what every save does, via the cache reset
            assert manager.get_album("openclip").min_search_score == pytest.approx(0.1)

    notices = [r for r in caplog.records if "score floor" in r.getMessage()]
    assert len(notices) == 1, [r.getMessage() for r in notices]


def test_a_newer_config_is_left_alone(tmp_path):
    """A config stamped by a future build keeps its stamp: claiming it as
    1.1.0 would tell that build its own migrations had already run."""
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        yaml.safe_dump(
            {
                "config_version": "2.0.0",
                "albums": {
                    "openclip": _album_entry(
                        tmp_path, "open-clip:ViT-L-14/dfn2b_s39b", 0.2
                    )
                },
            },
            indent=2,
        )
    )

    manager = ConfigManager(config_path=config_path)
    assert manager.get_album("openclip").min_search_score == pytest.approx(0.2)
    assert manager.load_config().config_version == "2.0.0"


def test_migration_leaves_hand_tuned_and_matching_floors_alone(tmp_path):
    """Only the machine-chosen 0.2 moves, and only where the encoder now
    resolves to something else: a value the user typed is theirs."""
    config_path = tmp_path / "config.yaml"
    _write_config(
        config_path,
        {
            "tuned": _album_entry(tmp_path, "open-clip:ViT-L-14/dfn2b_s39b", 0.15),
            "openai": _album_entry(tmp_path, "openai-clip:ViT-B/32", 0.2),
            "siglip": _album_entry(
                tmp_path, "siglip:google/siglip2-large-patch16-256", 0.005
            ),
        },
    )

    manager = ConfigManager(config_path=config_path)
    assert manager.get_album("tuned").min_search_score == pytest.approx(0.15)
    # 0.2 *is* this encoder's resolved default, so it is not a legacy value.
    assert manager.get_album("openai").min_search_score == pytest.approx(0.2)
    assert manager.get_album("siglip").min_search_score == pytest.approx(0.005)


def test_search_without_an_explicit_floor_uses_the_encoder_default(
    tmp_path, monkeypatch
):
    """The search entry point is reachable without an album — anything
    holding an ``Embeddings`` can call it — so its own default has to be
    encoder-aware too rather than a CLIP number that silences OpenCLIP.

    Note this only helps callers that pass an ``encoder_spec``: the
    ``search_images``/``search_text`` CLI entry points build a bare
    ``Embeddings``, which falls back to ``LEGACY_ENCODER_SPEC`` and so
    resolves OpenAI CLIP's 0.2 (as does the query encoder they use, which is
    a separate problem for a modern index).
    """
    from photomap.backend import encoders as encoders_module
    from photomap.backend.embeddings import Embeddings

    stored = np.array([[1.0, 0.0], [0.0, 1.0]], dtype=np.float32)
    npz_path = tmp_path / "stub.npz"
    np.savez(
        npz_path,
        embeddings=stored,
        filenames=np.array(["a.jpg", "b.jpg"]),
        modification_times=np.array([1.0, 2.0]),
        metadata=np.array([{}, {}], dtype=object),
        model_id=np.array("open-clip:stub"),
        embedding_dim=np.array(2),
    )

    class StubEncoder:
        model_id = "open-clip:stub"
        embedding_dim = 2
        device = "cpu"

        def encode_text(self, texts):
            # Scores 0.15 against "a.jpg": inside OpenCLIP's match band, but
            # under the legacy 0.2 floor.
            vec = np.array([[0.15, 0.0]], dtype=np.float32)
            return vec

        def calibrate_similarity(self, cosines):
            return cosines

        def close(self):
            pass

    encoders_module.clear_encoder_cache()
    monkeypatch.setattr(encoders_module, "build_encoder", lambda *a, **k: StubEncoder())

    try:
        emb = Embeddings(embeddings_path=npz_path, encoder_spec="open-clip:stub")
        indices, scores = emb.search_images_by_text_and_image(
            positive_query="anything", image_weight=0.0, positive_weight=1.0, top_k=2
        )

        assert indices, "a match inside OpenCLIP's band must survive the default floor"
        assert scores[0] == pytest.approx(0.15, abs=1e-3)
    finally:
        # The cache is process-global and the idle watcher reads attributes a
        # stub does not have, so a failure here must not leave one behind.
        encoders_module.clear_encoder_cache()


@posix_modes_only
def test_config_rewrites_keep_the_file_private(tmp_path):
    """config.yaml holds an InvokeAI password and a LocationIQ key. The
    atomic write replaces the file rather than writing through it, so a mode
    the user tightened has to survive — otherwise the next album edit hands
    the secrets to every account on the machine."""
    import os
    import stat

    from photomap.backend.util import atomic_write_text

    path = tmp_path / "config.yaml"
    path.write_text("albums: {}\n")
    os.chmod(path, 0o600)

    atomic_write_text(path, "albums: {}\n# rewritten\n")

    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_config_rewrites_follow_a_symlink(tmp_path):
    """A dotfiles setup symlinks config.yaml into a repo; replacing the link
    with a regular file would leave the real config behind, unchanged and no
    longer connected to the app."""
    from photomap.backend.util import atomic_write_text

    real = tmp_path / "repo" / "config.yaml"
    real.parent.mkdir()
    real.write_text("albums: {}\n")
    link = tmp_path / "config.yaml"
    link.symlink_to(real)

    atomic_write_text(link, "albums: {}\n# rewritten\n")

    assert link.is_symlink()
    assert "rewritten" in real.read_text()


@posix_modes_only
def test_a_config_written_for_the_first_time_is_private(tmp_path):
    """There is no existing mode to preserve on the very first write, and the
    process umask is typically 022 — which would publish the InvokeAI
    password to every account on the machine from the moment the file exists.
    """
    import os
    import stat

    from photomap.backend.util import atomic_write_text

    path = tmp_path / "config.yaml"
    previous_umask = os.umask(0o022)
    try:
        atomic_write_text(path, "invokeai_password: hunter2\n")
    finally:
        os.umask(previous_umask)

    assert stat.S_IMODE(path.stat().st_mode) == 0o600


@posix_modes_only
def test_the_temp_file_is_never_wider_than_the_target(tmp_path, monkeypatch):
    """The rewrite goes through a .tmp holding the same secrets, so it has to
    be private *before* it is opened for the payload, not tightened after.

    The leftover .tmp here is the case the creation mode cannot cover: a file
    inherited from a killed run keeps whatever mode it already had, so
    without the explicit narrowing the password would be written into a
    world-readable file and only tightened once it was already there.
    """
    import os
    import pathlib
    import stat

    from photomap.backend import util

    path = tmp_path / "config.yaml"
    path.write_text("albums: {}\n")
    os.chmod(path, 0o600)
    stale = tmp_path / "config.yaml.tmp"
    stale.write_text("left behind by a killed write\n")
    os.chmod(stale, 0o644)

    modes_when_opened: list[int] = []
    real_open = pathlib.Path.open

    def watching_open(self, *args, **kwargs):
        if self.name.endswith(".tmp"):
            modes_when_opened.append(stat.S_IMODE(self.stat().st_mode))
        return real_open(self, *args, **kwargs)

    monkeypatch.setattr(pathlib.Path, "open", watching_open)
    util.atomic_write_text(path, "invokeai_password: hunter2\n")

    assert modes_when_opened == [0o600], (
        f".tmp was opened for the payload at {[oct(m) for m in modes_when_opened]}"
    )
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert "hunter2" in path.read_text()
