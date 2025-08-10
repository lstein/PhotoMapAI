# PhotoMap

Rediscover your photo collection!

PhotoMap is a fast, modern image browser and search tool for large photo collections. It supports text and image-based search, semantic clustering, and interactive slideshows with a responsive web interface. Its unique feature is a "semantic map" that clusters and visualizes your images by their content. Browse the semantic map to find and explore thematically-related groups of photos, or use text and/or image similarity search to find specific people, places, events and themes.

![Semantic Map](img/photomap_slide_with_semantic_map.png)

## Features
- Fast browsing of large image collections
- AI-based text and image similarity search
- Thematic image clustering and visualization
- Flexible album management
- Responsive UI for desktop and mobile
- Extensible backend (FastAPI)

## Quick Start


### Linux / Mac

1. **Create a virtual environment for the app:**

        python3 -m venv ~/photomap     (or choose your own installation location)
        source ~/photomap/bin/activate

2. **Install the app:**  
   From within the code repository (the one containing README.md)

        pip install .

3. **Run the app:**

        ~/photomap/bin/start_photomap

4. **Open your browser:**  
   Navigate to `http://localhost:8050`.

---

### Windows

Open a PowerShell window and type these commands in.

1. **Launch the Windows installer **
    - Navigate to the photomap source code folder and launch `installation/install_windows`.
    - If you are prompted to install python, please do so and try again. 
    - When prompted, select an install location for photomap. This will create a launcher script in the selected location named `start_photomap.bat`

3. **Run the app:**
    Launch `start_photomap.bat`.

4. **Open your browser:**  
   Navigate to `http://localhost:8050`

## Detailed Guides
- [Installation](installation.md)
- [User Guide](user-guide/basic-usage.md)
- [Configuration](configuration.md)
- [Developer Guide](developer/architecture.md)
- [Troubleshooting](troubleshooting.md)

---

For more details, see the sections below.
