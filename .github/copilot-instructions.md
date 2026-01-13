# PhotoMapAI - GitHub Copilot Instructions

## Project Overview

PhotoMapAI is an AI-powered image browser and search tool that enables semantic search, clustering, and visualization of large photo collections. It uses the CLIP computer vision model for text and image-based search, and provides a unique "semantic map" that clusters and visualizes images by their content.

## Architecture

### Tech Stack
- **Frontend**: HTML, CSS, JavaScript (ES6 modules), Swiper.js, Plotly.js
- **Backend**: Python 3.10-3.13, FastAPI, Uvicorn
- **AI/ML**: CLIP (clip-anytorch), PyTorch, scikit-learn, UMAP
- **Image Processing**: Pillow, pillow-heif
- **Testing**: pytest (Python), Jest (JavaScript)

### Project Structure
```
PhotoMapAI/
├── photomap/
│   ├── backend/          # FastAPI backend, routers, and business logic
│   │   ├── routers/      # API endpoints (album, search, umap, index, etc.)
│   │   ├── metadata_modules/  # Metadata extraction modules
│   │   └── *.py          # Core backend modules
│   └── frontend/         # Frontend assets
│       ├── static/       # JavaScript, CSS, images
│       └── templates/    # Jinja2 HTML templates
├── tests/
│   ├── backend/          # pytest tests for Python backend
│   └── frontend/         # Jest tests for JavaScript
├── docs/                 # MkDocs documentation
└── docker/               # Docker configurations
```

## Development Guidelines

### Code Style and Conventions

#### Python
- Use type hints for function parameters and return values
- Follow PEP 8 style guidelines
- Use docstrings for modules, classes, and functions
- Prefer f-strings for string formatting
- Use pathlib.Path for file path operations instead of os.path
- Import organization: standard library → third-party → local imports
- Python files must pass ruff check

#### JavaScript
- Use ES6 modules with explicit imports/exports
- Use const/let instead of var
- Use descriptive function and variable names
- Add comments for complex logic, especially in event handlers
- Follow existing file structure: one module per file with clear responsibilities
- JavaScript files must pass `npm lint` and `npm run format:check`

### Testing

#### Python Tests (pytest)
- Location: `tests/backend/`
- Run with: `pytest tests` or `make test`
- Use fixtures defined in `fixtures.py` for common test setup
- Test naming: `test_<functionality>.py` and `test_<feature_name>()`
- Always test API endpoints with the FastAPI test client

#### JavaScript Tests (Jest)
- Location: `tests/frontend/`
- Run with: `npm test` or `make test`
- Use Jest with jsdom environment
- Test DOM interactions and event handlers

### Building and Running

#### Development Setup
```bash
# Install development dependencies
pip install -e .[testing,development]

# Install JavaScript dependencies
npm install

# Run tests
make test

# Build documentation
make docs

# Build package
make build
```

#### Running the Application
```bash
# Start the PhotoMapAI server
start_photomap

# Server runs at http://localhost:8050
```

### API Structure

The backend uses FastAPI with modular routers:
- `/api/albums/` - Album management and configuration
- `/api/search/` - Image search (similarity, text, metadata)
- `/api/umap/` - UMAP visualization data
- `/api/index/` - Image indexing and embedding generation
- `/api/curation/` - Image curation tools
- `/api/filetree/` - File system navigation
- `/api/upgrade/` - Application upgrade and version management

### Configuration Management

- Configuration stored in YAML files managed by `config.py`
- Albums are defined with paths, embeddings, and metadata
- Use `get_config_manager()` to access the singleton ConfigManager instance
- Configuration includes album settings, UMAP parameters, and application preferences

### Important Patterns

#### Backend
- Use FastAPI dependency injection for shared resources
- Routers should be modular and focused on specific functionality
- Use Pydantic models for request/response validation
- Log important operations with Python's logging module
- Handle file paths with pathlib.Path
- Use the ConfigManager singleton pattern via `get_config_manager()` for accessing application configuration

#### Frontend
- State management: Use the centralized `state.js` module for application state
- Event handling: Register global keyboard shortcuts in `events.js`
- Modular design: Each feature (UMAP, slideshow, metadata) has its own module
- Use localStorage for persisting user preferences
- Use sessionStorage for temporary state during navigation

### Dependencies and Security

- Keep dependencies minimal and well-maintained
- Use `pillow-heif` for HEIC image support
- Pin setuptools<67 to avoid CLIP deprecation warnings
- All image processing is local; no data sent to external services

### Documentation

- Use MkDocs with Material theme for documentation
- Documentation location: `docs/`
- Build docs: `make docs`
- Deploy docs: `make deploy-docs` (GitHub Pages)
- Include developer documentation in `docs/developer/`

### Common Tasks

#### Adding a New API Endpoint
1. Create or update a router in `photomap/backend/routers/`
2. Use Pydantic models for request/response validation
3. Add appropriate error handling
4. Include the router in `photomap_server.py`
5. Add tests in `tests/backend/`

#### Adding Frontend Features
1. Create a new module in `photomap/frontend/static/javascript/`
2. Export functions that other modules can import
3. Update `events.js` if adding keyboard shortcuts
4. Test with Jest in `tests/frontend/`
5. Update state.js if managing new application state

#### Working with Images
- Use PIL/Pillow for image operations
- Generate thumbnails for performance
- Support HEIC format via pillow-heif
- Store embeddings in .npz format (NumPy)

### Performance Considerations

- Frontend: Lazy load images, use thumbnails for grid views
- Backend: Cache embeddings, use async operations where appropriate
- UMAP: Pre-compute and cache UMAP projections per album
- Search: Use efficient similarity search with pre-computed embeddings

### Debugging

- Backend logs: Use Python logging module with appropriate levels
- Frontend: Use browser DevTools console
- Test specific functionality in isolation before integration
- Check GitHub Actions for CI/CD test results

## Additional Resources

- [User Guide](https://lstein.github.io/PhotoMapAI/user-guide/basic-usage/)
- [Developer Architecture Guide](https://lstein.github.io/PhotoMapAI/developer/architecture/)
- [Installation Guide](https://lstein.github.io/PhotoMapAI/installation/)
- [Contributing Guide](CONTRIBUTING.md)
