**Languages:** English | [繁體中文](README.zh-TW.md)

# PhotoMapAI

Rediscover your photo collection!

PhotoMapAI is a fast, modern image browser and search tool for large photo collections. It uses the CLIP computer vision model to enable text and image-based search, image clustering, and interactive slideshows with a responsive web interface. Its unique feature is a "semantic map" that clusters and visualizes your images by their content. Browse the semantic map to find and explore thematically-related groups of photos, or use text and/or image similarity search to find specific people, places, events, styles and themes.


## Features

- Fast browsing of large image collections
- All images are local to your computer; nothing goes out to the internet
- AI-based text and image similarity search
- Thematic image clustering and visualization
- Flexible album management
- Bookmark images for quick access, batch download, or deletion
- Curator mode for selecting a balanced set of images to use for LoRA training
- Responsive UI for desktop and mobile
- Support for wide range of image formats, including Apple's HEIC
- Integration with the <a href="https://github.com/invoke-ai/InvokeAI">InvokeAI</a> AI image generation system
- Extensible backend (FastAPI)

### **[Try it out!](https://photomap.4crabs.org)**

## The Semantic Map

PhotoMap's unique feature is its ability to identify thematically similar images and automatically cluster them, creating a "semantic map":

<img src="https://github.com/lstein/PhotoMapAI/blob/master/docs/img/photomap_intro.png?raw=true" alt="Big Semantic Map" class="img-hover-zoom">

In this map, each image in the photo collection is represented as a dot. The colors distinguish different clusters of related images. You can zoom in and out of the map and pan around it. Hover the mouse over a dot in order to see a preview thumbnail of its image, or click on a cluster to view its contents at full resolution.

You can move the semantic map around, shrink it down in size, or hide it altogether. As you browse your photo collection, a yellow dot marker will highlight the location of the current image in the map.

## Text and Image Similarity Search

PhotoMap lets you search your collection by similarity to another image, by text, or by a combination of image and text as shown below:

<img src="https://github.com/lstein/PhotoMapAI/blob/master/docs/img/photomap_search_interface.png?raw=true" alt="Big Semantic Map" class="img-hover-zoom">

You can start an image similarity search by uploading a local image file, dragging an image from a web browser window or file browser, or by selecting an existing image from your collection. There's also a "Text to Avoid" field, which can be used to disfavor certain image content.

## Support for Image Metadata

When viewing a photo in full-screen mode, you can pop out a little drawer to show its metadata, including the GPS location (if available), and the camera/phone settings:

<img src="https://github.com/lstein/PhotoMapAI/blob/master/docs/img/photomap_metadata.png?raw=true" alt="Image Metadata" class="img-hover-zoom">

## Curator Mode

The curator mode allows you to use a combination of algorithms and manual selection to identify a subset of images suitable for use to train image generation models (such as LoRAs) and classifiers. 

<img src="https://github.com/lstein/PhotoMapAI/blob/master/docs/img/curator-panel.png?raw=true" alt="Image Curator Panel" class="img-hover-zoom">

### InvokeAI Support

If you are a user of the [InvokeAI](https://github.com/invoke-ai/InvokeAI) text-to-image generation tool, you can get quick access to the key settings used to generate the image, including the prompts, model and LoRAs in use, and the input images used for IPAdapters, ControlNets and the img2img raster layer. You can also display and copy the full generation graph in native JSON format and copy it to the clipboard.

<img src="https://github.com/lstein/PhotoMapAI/blob/master/docs/img/photomap_invokeai.png?raw=true" alt="InvokeAI Metadata" class="img-hover-zoom">

## Other Features

PhotoMap supports most of the other features you would expect, including support for multiple separate photo albums, the ability to browse photos chronologically, an uncluttered fullscreen mode, and of course a configurable slideshow mode that can show images sequentially or shuffled.

---

## Quick Start

The easiest way to install PhotoMapAI is the native installer for your platform. **You don't need Python, CUDA, or anything else first** — the installer sets everything up on first launch.

Download the file for your system from the latest [Releases page](https://github.com/lstein/PhotoMapAI/releases) (under **Assets**), where `X.X.X` is the current version:

| Platform | Download | Install |
|----------|----------|---------|
| **macOS** | `PhotoMapAI-X.X.X.dmg` | Open the `.dmg`, drag **PhotoMapAI** to **Applications** |
| **Windows** | `PhotoMapAI-X.X.X-setup.exe` | Run the installer (no admin rights needed) |
| **Linux** | `PhotoMapAI-X.X.X-x86_64.AppImage` | `chmod +x` it and double-click, or run from a terminal |

The **first** launch downloads a private copy of Python and the AI libraries (a multi-gigabyte, one-time download that takes a few minutes; a console window shows progress). When it finishes the server starts and your browser opens automatically. Later launches start in seconds. An NVIDIA GPU is detected and used automatically; Apple Silicon acceleration is automatic too.

For PyPI, Docker, and manual install instructions, see the [Installation guide](https://lstein.github.io/PhotoMapAI/installation/).

### Install from PyPI (command line)

If you already have Python 3.10–3.14 and prefer the command line:

```bash
uv tool install photomapai --torch-backend auto   # or: pip install photomapai
start_photomap
```

Then open your browser to [http://127.0.0.1:8050](http://127.0.0.1:8050) (it opens automatically) and follow the prompts to create your first album.

## Other Installation Methods

In addition to the above, PhotoMapAI can be installed via [Docker](https://lstein.github.io/PhotoMapAI/installation/#alternative-docker), [PyPI](https://lstein.github.io/PhotoMapAI/installation/#alternative-install-from-pypi), or [from source](https://lstein.github.io/PhotoMapAI/installation/#manual-installation-from-source).

## Detailed Guides

- [Installation](https://lstein.github.io/PhotoMapAI/installation/)
- [User Guide](https://lstein.github.io/PhotoMapAI/user-guide/basic-usage/)
- [Configuration](https://lstein.github.io/PhotoMapAI/user-guide/configuration/)
- [Developer Guide](https://lstein.github.io/PhotoMapAI/developer/architecture.md)
- [Troubleshooting](https://lstein.github.io/PhotoMapAI/)
