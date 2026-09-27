import os
import shutil
import tempfile
from pathlib import Path

import pytest
import yaml


def _point_config_at_a_temp_file() -> Path:
    """Aim PHOTOMAP_CONFIG at a throwaway file before anything imports photomap.

    This has to happen at conftest import, not in a fixture. Several modules
    (the routers among them) call the lru_cached ``get_config_manager()`` at
    import time, and test modules are imported during collection, before any
    fixture runs. A test file importing a router at module level would
    otherwise bind the session's config singleton to the developer's real
    config file, and every test that saves settings or adds an album would
    write to it.
    """
    config_path = Path(tempfile.mkdtemp(prefix="photomap-test-config-")) / "test_config.yaml"
    config_data = {
        "config_version": "1.0.0",
        "albums": {},
        "locationiq_api_key": "dummy",
    }
    with open(config_path, "w") as f:
        yaml.dump(config_data, f)
    os.environ["PHOTOMAP_CONFIG"] = str(config_path)
    return config_path


_SESSION_CONFIG_PATH = _point_config_at_a_temp_file()

# Import fixtures so they're available to all tests
from fixtures import client, mixed_album, new_album, new_media_album  # noqa: E402, F401


@pytest.fixture(autouse=True)
def isolate_video_frame_cache(tmp_path_factory, monkeypatch):
    """Keep the video-frame cache out of the developer's real cache directory.

    ``VideoFrameCache`` defaults its root to ``platformdirs.user_cache_dir``,
    and the serving routes construct it as ``VideoFrameCache(album_key)`` with
    no seam to inject a root — so without this, a test using an album keyed
    like a real one writes into (and ``clear()`` deletes from)
    ``~/.cache/photomap/video_frames/``. ``set_temp_config_env`` isolates only
    ``PHOTOMAP_CONFIG``, which does not cover this.

    Patched per test, so parallel or repeated runs cannot collide on a shared
    directory either.
    """
    from photomap.backend import video_cache

    root = tmp_path_factory.mktemp("video_frames")
    monkeypatch.setattr(video_cache, "frame_cache_root", lambda: root)
    return root


@pytest.fixture(autouse=True)
def isolate_video_transcode_cache(tmp_path_factory, monkeypatch):
    """The same isolation for converted videos, for the same reason.

    ``TranscodeCache`` also defaults to ``platformdirs.user_cache_dir`` and is
    also constructed inside the routes with no seam, and deleting an album
    ``rmtree``s its directory. The stakes are higher here than for stills:
    these files are whole movies.

    The job registry is reset alongside it. Jobs are module-level state keyed
    by album and content digest, so a test that leaves a "failed" entry behind
    would make the next test's request return that stale failure instead of
    starting work.
    """
    from photomap.backend import video_transcode

    root = tmp_path_factory.mktemp("video_transcodes")
    monkeypatch.setattr(video_transcode, "transcode_cache_root", lambda: root)
    video_transcode._reset_jobs_for_tests()
    yield root
    video_transcode._reset_jobs_for_tests()


@pytest.fixture(autouse=True)
def isolate_user_data_dir(tmp_path_factory, monkeypatch):
    """Keep derived board-album indexes out of the real user data directory.

    ``default_board_index_path`` resolves against
    ``platformdirs.user_data_dir``, and deleting a board album ``rmtree``s that
    album's directory under it — so a test using an album key that matches a
    real one deletes the real index. ``set_temp_config_env`` isolates only
    ``PHOTOMAP_CONFIG``, the same gap ``isolate_video_frame_cache`` covers for
    the cache directory.
    """
    from photomap.backend import config as config_module

    root = tmp_path_factory.mktemp("user_data")
    monkeypatch.setattr(config_module, "user_data_dir", lambda *a, **k: str(root))
    return root


@pytest.fixture(scope="session", autouse=True)
def set_temp_config_env():
    """Fail the session outright if the config singleton escaped the temp file,
    and remove the temp file's directory when the session ends."""
    from photomap.backend.config import get_config_manager

    actual = Path(get_config_manager().config_path).resolve()
    assert actual == _SESSION_CONFIG_PATH.resolve(), (
        f"Tests would write to {actual}, not the temp config; something built "
        "the config manager before conftest set PHOTOMAP_CONFIG."
    )
    yield
    shutil.rmtree(_SESSION_CONFIG_PATH.parent, ignore_errors=True)
