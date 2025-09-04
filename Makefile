# simple Makefile with scripts that are otherwise hard to remember
# to use, run from the repo root `make <command>`

default: help

help:
	@echo "test             Run the unit tests."
	@echo "build            Build the package for upload to PyPi."
	@echo "wheel            Build the wheel for the current version."
	@echo "docker-build     Build the Docker image."
	@echo "docker-demo      Build the Docker demo site image."
	@echo "docs             Serve the mkdocs site with live reload."
	@echo "deploy-docs      Deploy the mkdocs site to GitHub pages."

# Run the unit tests
test:
	pytest ./tests

.PHONY: build
build:
	python -m build

.PHONY: docker-build
docker-build:
	docker build -t photomapai-demo .

.PHONY: docker-demo
docker-demo:
	version=$$(grep '^version\s*=' pyproject.toml | sed -E 's/.*=\s*"([^"]+)".*/\1/') \
	&& user=`whoami` \
	&& docker build -f docker/Dockerfile.demo -t $$user/photomapai-demo:v$$version . \
	&& docker tag $$user/photomapai-demo:v$$version $$user/photomapai-demo:latest

.PHONY: docker
docker:
	version=$$(grep '^version\s*=' pyproject.toml | sed -E 's/.*=\s*"([^"]+)".*/\1/') \
	&& user=`whoami` \
	&& docker build -f docker/Dockerfile -t $$user/photomapai:v$$version  . \
	&& docker tag $$user/photomapai:v$$version $$user/photomapai:latest 

# Serve the mkdocs site w/ live reload
.PHONY: docs
docs:
	mkdocs build --clean
	mkdocs serve --dev-addr=0.0.0.0:8000

deploy-docs:
	mkdocs gh-deploy
