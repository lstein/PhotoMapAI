# Frontend Architecture

The PhotoMapAI frontend is a modular, responsive web application built with HTML, CSS, and JavaScript (ES6 modules). It provides an interactive user interface for browsing, searching, and visualizing photo collections.

---

## Structure

The frontend code is organized into the following main components:

- **Image Browsing (`swiper.js`)**  
  Handles image navigation, transitions, and keyboard/touch controls.

- **Image Grid (`grid-view.js`)**
  The image grid display.

- **Random Seeking (`seekslider.js`)**
  Slider control that allows the user to seek to arbitrary positions within album or search results.

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

- **Stylesheets (`slides.css`)**  
  Provides base styles, responsive layouts, and theme customization.

- **State Tracking (`state.js`, `slide-state.js`)**
  Tracking of the current image and search results (`slide-state.js`), and all other stateful variables (`state.js`)

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

4. **Event Passing**
  A series of custom events couple user actions to changes in the user interface. Major events are:
  - `albumChanged` -- The current album has changed.
  - `slideChanged` -- The currently selected slide (image) has changed.
  - `searchResultsChanged` -- The list of search results (including the selected umap cluster) has changed.
  - `seekToSlideIndex` -- The user wishes to jump to an arbitrary slide in the album or search results.
  - `swiperModeChanged` -- The user wishes to change from browse mode to grid mode or vice-versa.
  - `settingsUpdated` -- One or more settings has been changed.

---

## Extending the Frontend

- **Add new panels or dialogs** by creating new JS modules and updating the main HTML template.
- **Customize styles** in `slides.css` and `extra.css`.
- **Integrate new visualizations** by importing libraries and adding new modules.
- **Connect to new backend endpoints** using the Fetch API.

---

## File Locations

- **JavaScript:** `photomap/frontend/static/javascript/`
- **CSS:** `photomap/frontend/static/css`
- **HTML Templates:** `photomap/frontend/static/templates/`
  - Note that most of the HTML templates are in a subdirectory called `modules`.
- **Documentation:** `docs/developer/frontend.md`

---

## Further Reading

- [Architecture Overview](architecture.md)
- [API Reference](api.md)