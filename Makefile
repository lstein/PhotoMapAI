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
	docker build -f docker/Dockerfile.demo -t photomapai-demo .

.PHONY: docker
docker:
	docker build -f docker/Dockerfile -t photomapai .

# Serve the mkdocs site w/ live reload
.PHONY: docs
docs:
	mkdocs build --clean
	mkdocs serve --dev-addr=0.0.0.0:8000

deploy-docs:
	# sed 's|img/|docs/img/|g' docs/index.md > README.md
	mkdocs gh-deploy
