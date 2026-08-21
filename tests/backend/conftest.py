import os

import pytest
import yaml

# Import fixtures so they're available to all tests
from fixtures import client, new_album, new_media_album  # noqa: F401


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
def set_temp_config_env(tmp_path_factory):
    config_path = tmp_path_factory.mktemp("data") / "test_config.yaml"
    # Create a temporary config file
    config_data = {
        "config_version": "1.0.0",
        "albums": {},
        "locationiq_api_key": "dummy",
    }
    with open(config_path, "w") as f:
        yaml.dump(config_data, f)
    os.environ["PHOTOMAP_CONFIG"] = str(config_path)
