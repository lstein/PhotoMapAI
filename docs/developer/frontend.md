# Frontend Architecture

The PhotoMap frontend is a modular, responsive web application built with HTML, CSS, and JavaScript (ES6 modules). It provides an interactive user interface for browsing, searching, and visualizing photo collections.

---

## Structure

The frontend code is organized into the following main components:

- **Slideshow & Gallery (`swiper.js`, `seek-slider.js`)**  
  Handles image navigation, transitions, and keyboard/touch controls.

- **Metadata Overlay (`overlay.js`)**  
  Displays image metadata, prompts, and reference images as overlays.

- **Search Panel (`search.js`)**  
  Provides AI-enabled search (similarity, text, metadata) and displays results.

- **UMAP Visualization (`umap.js`)**  
  Renders interactive UMAP plots for image clustering and exploration.

- **Album Management (`album.js`)**  
  Allows users to create, edit, and manage albums.

- **Settings Dialog (`settings.js`)**  
  Manages application settings, album selection, and configuration options.

- **Event Handling (`events.js`, `touch.js`)**  
  Centralizes event listeners for slide transitions, overlay toggling, and gesture support.

- **Stylesheets (`slides.css`, `extra.css`)**  
  Provides base styles, responsive layouts, and theme customization.

---

## Key Technologies

- **JavaScript (ES6 modules)**: Modular code organization and dynamic UI updates.
- **Swiper.js**: Responsive slideshow and gallery navigation.
- **Plotly.js**: Interactive UMAP visualizations.
- **Fetch API**: Communicates with backend REST endpoints.
- **CSS3**: Responsive design and theming.

---

## Data Flow

1. **User Interaction**  
   Users interact with the UI via clicks, taps, swipes, and keyboard shortcuts.

2. **API Requests**  
   The frontend sends requests to backend endpoints for images, metadata, search, and album management.

3. **Rendering**  
   The UI updates dynamically based on backend responses, displaying images, overlays, search results, and visualizations.

---

## Extending the Frontend

- **Add new panels or dialogs** by creating new JS modules and updating the main HTML template.
- **Customize styles** in `slides.css` and `extra.css`.
- **Integrate new visualizations** by importing libraries and adding new modules.
- **Connect to new backend endpoints** using the Fetch API.

---

## File Locations

- **JavaScript:** `photomap/frontend/static/javascript/`
- **CSS:** `photomap/frontend/static/`
- **Templates:** `photomap/frontend/templates/`
- **Documentation:** `docs/developer/frontend.md`

---

## Further Reading

- [Architecture Overview](architecture.md)
- [API Reference](api.md)