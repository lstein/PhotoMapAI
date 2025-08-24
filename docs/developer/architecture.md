# PhotoMapAI Architecture

PhotoMapAI is a modular web application designed for efficient photo management, AI-powered search, and interactive visualization. Its architecture is organized into distinct layers and components to ensure scalability, maintainability, and ease of development.

---

## Overview

PhotoMapAI consists of three main layers:

1. **Frontend**
    - Built with HTML, CSS, and JavaScript (ES6 modules).
    - Provides a responsive user interface for browsing, searching, and visualizing photos.
    - Uses libraries such as Swiper for slideshows and Plotly for UMAP visualizations.

2. **Backend**  
    - Powered by FastAPI (Python).
    - Handles API requests, image processing, metadata extraction, and search operations.
    - Integrates with AI models for similarity and text-based search.

3. **Storage & Configuration**  
    - Stores images, thumbnails, and metadata on disk.
    - Uses YAML configuration files to manage albums and application settings.

---

## Component Diagram

```
+-------------------+      REST API      +-------------------+      Disk/YAML     +--------------+
|   Frontend UI     | <----------------> |     Backend       | <----------------> | Images/Config|
+-------------------+                    +-------------------+                    +--------------+
```
---

## Key Components

### Frontend

- **Slideshow & Gallery**: Interactive image browsing with keyboard and touch support.
- **Search Panel**: AI-enabled search (similarity, text, metadata).
- **UMAP Visualization**: Clustered view of image embeddings.
- **Settings & Album Manager**: Album creation, editing, and configuration.

### Backend

- **API Routers**:  
  - `/search`: Search endpoints (similarity, text, metadata).
  - `/albums`: Album management.
  - `/images`: Image and thumbnail serving.
- **Metadata Extraction**: Parses and formats image metadata (EXIF, AI-generated).
- **Indexing & Embeddings**: Generates and stores image embeddings for fast search.
- **Config Manager**: Loads and updates YAML configuration files.

### Storage

- **Images**: Original and processed images stored in album directories.
- **Thumbnails**: Cached thumbnails for fast display.
- **Metadata**: JSON and YAML files for image and album metadata.

---

## Data Flow

1. **User Interaction**:  
   User browses or searches for images via the frontend UI.

2. **API Request**:  
   Frontend sends requests to backend endpoints for images, search, or metadata.

3. **Processing**:  
   Backend processes requests, performs AI search, extracts metadata, and returns results.

4. **Rendering**:  
   Frontend updates UI with images, overlays, and search results.

---

## Extensibility

- **Modular Routers**: Easily add new API endpoints.
- **Pluggable Metadata Modules**: Support for custom metadata extraction.
- **Frontend Components**: Add new panels or visualizations with minimal changes.

---

## Technologies Used

- **Frontend**: HTML5, CSS3, JavaScript (ES6), Swiper, Plotly
- **Backend**: Python 3, FastAPI, Pydantic, PIL/Pillow, UMAP, YAML
- **Storage**: Local filesystem, YAML/JSON

---

## Development Notes

- All major components are documented in the `docs/developer/` section.
- See `docs/developer/api.md` for endpoint details.
- See `docs/developer/frontend.md` for UI component structure.

---