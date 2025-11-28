import os
import pytest
import yaml

@pytest.fixture(scope="session", autouse=True)
def set_temp_config_env(tmp_path_factory):
    config_path = tmp_path_factory.mktemp("data") / "test_config.yaml"
    # Create a temporary config file
    config_data = {
        "config_version": "1.0.0",
        "albums": {},
        "locationiq_api_key": "dummy"
    }
    with open(config_path, "w") as f:
        yaml.dump(config_data, f)
    os.environ["PHOTOMAP_CONFIG"] = str(config_path)
