# simple Makefile with scripts that are otherwise hard to remember
# to use, run from the repo root `make <command>`

# Version of uv to bundle into the launcher. Keep in sync with the UV_VERSION
# pin in .github/workflows/deploy-launcher.yml.
UV_VERSION ?= 0.11.19

default: help

help:
	@echo "test             Run the unit tests."
	@echo "build            Build the package for upload to PyPi."
	@echo "wheel            Build the wheel for the current version."
	@echo "docker-build     Build the Docker image."
	@echo "docker-demo      Build the Docker demo site image."
	@echo "docs             Serve the mkdocs site with live reload."
	@echo "deploy-docs      Deploy the mkdocs site to GitHub pages."
	@echo "launcher         Build the launcher binary (fast, no embedded uv) into dist/."
	@echo "appimage         Build the Linux launcher AppImage into dist/."
	@echo "backend-lint     Run Python backend linting with Ruff."
	@echo "frontend-lint    Run JavaScript frontend linting with ESLint and Prettier."
	@echo "lint             Run both backend and frontend linting."

# Run the unit tests
test:
	npm install
	npm test
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
	mkdocs serve

deploy-docs:
	mkdocs gh-deploy

# Build just the launcher binary for fast dev iteration (~1s). No embedded uv,
# so the binary downloads uv on first run; no packaging. Output: dist/photomap.
# Run it with `./dist/photomap`. Use `make appimage` for the distributable.
.PHONY: launcher
launcher:
	@command -v go >/dev/null || { echo "Go is required: https://go.dev/dl/"; exit 1; }
	version=$$(grep '^version\s*=' pyproject.toml | sed -E 's/.*=\s*"([^"]+)".*/\1/') \
	&& mkdir -p dist \
	&& echo "Building launcher v$$version (no embedded uv)..." \
	&& ( cd launcher && go build -ldflags "-X main.version=$$version" -o ../dist/photomap . ) \
	&& echo "Built dist/photomap"

# Build the Linux launcher AppImage on demand (the same steps CI runs):
#   1. fetch the pinned uv binary into launcher/assets/uv-bin (cached after first run)
#   2. compile the Go launcher with the uv binary embedded (-tags embed_uv)
#   3. package launcher + icon + .desktop into a single AppImage via appimagetool
# Output: dist/PhotoMapAI-<version>-x86_64.AppImage
.PHONY: appimage
appimage:
	@command -v go >/dev/null || { echo "Go is required: https://go.dev/dl/"; exit 1; }
	version=$$(grep '^version\s*=' pyproject.toml | sed -E 's/.*=\s*"([^"]+)".*/\1/') \
	&& mkdir -p dist launcher/assets \
	&& if [ ! -f launcher/assets/uv-bin ]; then \
		echo "Fetching uv $(UV_VERSION)..." ; \
		curl -fsSL -o /tmp/uv-$(UV_VERSION).tar.gz "https://github.com/astral-sh/uv/releases/download/$(UV_VERSION)/uv-x86_64-unknown-linux-gnu.tar.gz" ; \
		tar -xzf /tmp/uv-$(UV_VERSION).tar.gz --strip-components=1 -C launcher/assets uv-x86_64-unknown-linux-gnu/uv ; \
		mv launcher/assets/uv launcher/assets/uv-bin ; \
	fi \
	&& echo "Building launcher v$$version (uv embedded)..." \
	&& ( cd launcher && go build -tags embed_uv -ldflags "-X main.version=$$version" -o ../dist/photomap . ) \
	&& if [ ! -x /tmp/appimagetool ]; then \
		echo "Fetching appimagetool..." ; \
		curl -fsSL -o /tmp/appimagetool "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage" ; \
		chmod +x /tmp/appimagetool ; \
	fi \
	&& PATH="/tmp:$$PATH" APPIMAGE_EXTRACT_AND_RUN=1 \
		INSTALL/launcher/linux/build_appimage.sh \
		dist/photomap "$$version" "dist/PhotoMapAI-$$version-x86_64.AppImage" \
		photomap/frontend/static/icons/favicon-32x32.png \
	&& echo "" \
	&& echo "Built dist/PhotoMapAI-$$version-x86_64.AppImage"

# Run backend linting with Ruff
# fix with ruff check photomap tests photomap --fix
.PHONY: backend-lint
backend-lint:
	@echo "Running Ruff on Python backend..."
	ruff check photomap tests photomap

# Run frontend linting with ESLint and Prettier
# Fix with npm run lint:fix
#          npm run format
.PHONY: frontend-lint
frontend-lint:
	@echo "Installing npm dependencies if needed..."
	npm install
	@echo "Running ESLint on JavaScript frontend..."
	npm run lint
	@echo "Running Prettier check on JavaScript frontend..."
	npm run format:check

# Run both backend and frontend linting
.PHONY: lint
lint: backend-lint frontend-lint
