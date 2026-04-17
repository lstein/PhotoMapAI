# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

PhotoMapAI is a local-first image browser for large photo collections. It uses CLIP embeddings to power semantic text/image search and builds a UMAP "semantic map" that clusters images by content. The backend is FastAPI; the frontend is vanilla ES6 modules (no framework) using Swiper.js and Plotly.js. All processing is local — nothing is sent to external services.

## Common Commands

```bash
# Install for development (Python 3.10–3.13)
pip install -e .[testing,development]
npm install

# Run the server (entry point defined in pyproject.toml)
start_photomap               # http://localhost:8050

# Tests
make test                    # runs npm test + pytest
pytest tests                 # backend only
pytest tests/backend/test_search.py::test_text_search    # single test
npm test                     # frontend Jest only
NODE_OPTIONS='--experimental-vm-modules' jest tests/frontend/search.test.js  # single JS test

# Linting / formatting (CI enforces both)
make lint                    # runs backend-lint + frontend-lint
ruff check photomap tests --fix
npm run lint:fix
npm run format               # prettier write
npm run format:check         # CI check

# Docs
make docs                    # mkdocs serve on :8000
```

Ruff is configured for line-length 120, target py310, rules E/W/F/I/UP/B (see pyproject.toml). Jest runs in jsdom with experimental ESM (the project is `"type": "module"`).

## Architecture

### Backend layout (`photomap/backend/`)

- `photomap_server.py` — FastAPI app entry point. Wires up routers, mounts `/static` and Jinja2 templates, and defines the top-level `/` route. `start_photomap` from `pyproject.toml` runs `main()` here.
- `routers/` — one router per API surface: `album`, `search`, `umap`, `index`, `curation`, `filetree`, `upgrade`. Routers are included in `photomap_server.py`; `curation_router` is mounted with an explicit `/api/curation` prefix while the others set their own prefixes.
- `config.py` — YAML-backed album config. Access via the `get_config_manager()` singleton (lru_cached). `Album` is a Pydantic model that expands `~` in image paths. Config lives in a platformdirs user config directory.
- `embeddings.py` — CLIP embedding generation and persistence (`.npz`).
- `imagetool.py` — shared CLI entry point for `index_images`, `update_images`, `search_images`, `search_text`, `find_duplicate_images` (all registered as scripts in `pyproject.toml`).
- `metadata_extraction.py` / `metadata_formatting.py` — pulls EXIF + generator metadata (InvokeAI) out of images and formats for the UI.

### Metadata subsystem (`photomap/backend/metadata_modules/`)

This is the area under active refactor (current branch: `lstein/feature/refactor-invoke-metadata`). InvokeAI writes several incompatible metadata schemas into PNG tEXt chunks; the parser must auto-detect and upgrade.

- `invokemetadata.py` defines `GenerationMetadata` as a Pydantic `Annotated[Union[…], Field(discriminator="metadata_version")]` over `GenerationMetadata2`, `GenerationMetadata3`, and `GenerationMetadata5`. `GenerationMetadataAdapter.parse()` inspects fields like `canvas_v2_metadata`, `app_version`, and `model_weights` to inject the correct `metadata_version` when the source JSON predates the discriminator.
- `invoke/` holds the per-version schemas: `invoke2metadata.py`, `invoke3metadata.py`, `invoke5metadata.py`, plus `canvas2metadata.py` and `common_metadata_elements.py` for shared types. `invoke_metadata_view.py` is the version-agnostic facade consumed by `invoke_formatter.py`. When adding support for a new InvokeAI version, add a new `invokeNmetadata.py`, extend the Union in `invokemetadata.py`, teach `parse()` how to recognize legacy payloads that lack a `metadata_version` field, and extend `InvokeMetadataView`'s `isinstance` dispatch.
- `invoke_formatter.py` / `exif_formatter.py` render parsed metadata for the drawer UI; `slide_summary.py` produces the compact slideshow caption.
- `invoke-DELETE/` is a holdover from the refactor — leave it alone unless cleaning up.

### Frontend layout (`photomap/frontend/`)

- `static/javascript/` — one ES6 module per feature. No build step; modules are served directly and imported from `main.js` / `index.js`.
- `state.js` is the centralized application state. Prefer extending it over adding new globals.
- `events.js` owns global keyboard shortcuts; register new ones there rather than scattering listeners.
- `localStorage` is used for persisted user preferences, `sessionStorage` for per-navigation state.
- `templates/` — Jinja2 templates rendered by FastAPI.

### Tests

- `tests/backend/` — pytest. `conftest.py` + `fixtures.py` set up shared fixtures (test images in `tests/backend/test_images/`). Use the FastAPI `TestClient` for router tests; see `test_search.py`, `test_albums.py`, `test_curation.py` as templates.
- `tests/frontend/` — Jest with jsdom. `setup.js` provides DOM fixtures. See `tests/frontend/README.md` for setup notes.

## Conventions to follow

From `.github/copilot-instructions.md` — the parts that actually affect how you write code here:

- **Python:** type hints on public functions, `pathlib.Path` (not `os.path`) for file operations, f-strings, imports ordered stdlib → third-party → local (`photomap` is first-party to isort). Code must pass `ruff check photomap tests`.
- **Pinned quirk:** `setuptools<67` is intentional — avoids a deprecation warning from the CLIP dependency. Don't "fix" it.
- **New API endpoints:** add/extend a router under `photomap/backend/routers/`, use Pydantic models for request/response, include the router in `photomap_server.py`, add a `tests/backend/test_<name>.py`.
- **New frontend features:** create a module in `static/javascript/`, wire shared state through `state.js`, register shortcuts in `events.js`, add a Jest test.
- **JavaScript:** ES6 modules only, `const`/`let`, must pass `npm run lint` and `npm run format:check`.
