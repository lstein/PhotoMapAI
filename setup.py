import tomllib

from setuptools import setup

# Read configuration from pyproject.toml
with open("pyproject.toml", "rb") as f:
    pyproject = tomllib.load(f)

project = pyproject["project"]
py2app_config = pyproject["tool"]["py2app"]

# Minimal setup for py2app only
setup(
    name=project["name"],
    version=project["version"],
    app=[py2app_config["app"][0]],  # Entry point script
    options={"py2app": py2app_config["options"]},
    setup_requires=["py2app"],
)
