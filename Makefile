# simple Makefile with scripts that are otherwise hard to remember
# to use, run from the repo root `make <command>`

default: help

help:
	@echo "test                     Run the unit tests."
	@echo "update-config-docstring  Update the app's config docstring so mkdocs can autogenerate it correctly."
	@echo "wheel 			Build the wheel for the current version"
	@echo "tag-release              Tag the GitHub repository with the current version (use at release time only!)"
	@echo "openapi                  Generate the OpenAPI schema for the app, outputting to stdout"
	@echo "docs                     Serve the mkdocs site with live reload"

# Run the unit tests
test:
	pytest ./tests

# Update config docstring
update-config-docstring:
	echo Not implemented
	exit -1
	python scripts/update_config_docstring.py

# Tag the release
wheel:
	echo Not implemented
	exit -1
	cd scripts && ./build_wheel.sh

# Tag the release
tag-release:
	echo Not implemented
	exit -1
	cd scripts && ./tag_release.sh

# Generate the OpenAPI Schema for the app
openapi:
	echo Not implemented
	exit -1
	python scripts/generate_openapi_schema.py

# Serve the mkdocs site w/ live reload
.PHONY: docs
docs:
	echo Not implemented
	exit -1
	mkdocs serve
