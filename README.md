# PhotoMapAI

Rediscover your photo collection!

PhotoMapAI is a fast, modern image browser and search tool for large photo collections. It uses the CLIP computer vision model to enable text and image-based search, image clustering, and interactive slideshows with a responsive web interface. Its unique feature is a "semantic map" that clusters and visualizes your images by their content. Browse the semantic map to find and explore thematically-related groups of photos, or use text and/or image similarity search to find specific people, places, events, styles and themes.


## Features

- Fast browsing of large image collections
- All images are local to your computer; nothing goes out to the internet
- AI-based text and image similarity search
- Thematic image clustering and visualization
- Flexible album management
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

### InvokeAI Support

If you are a user of the [InvokeAI](https://github.com/invoke-ai/InvokeAI) text-to-image generation tool, you can get quick access to the key settings used to generate the image, including the prompts, model and LoRAs in use, and the input images used for IPAdapters, ControlNets and the img2img raster layer. You can also display and copy the full generation graph in native JSON format and copy it to the clipboard.

<img src="https://github.com/lstein/PhotoMapAI/blob/master/docs/img/photomap_invokeai.png?raw=true" alt="InvokeAI Metadata" class="img-hover-zoom">

## Other Features

PhotoMap supports most of the other features you would expect, including support for multiple separate photo albums, the ability to browse photos chronologically, an uncluttered fullscreen mode, and of course a configurable slideshow mode that can show images sequentially or shuffled.

---

## Quick Start

Here are quick start instructions for Windows, Mac and Linux users using the automated installer scripts that are provided with this package. For instructions on manual installation, see [Installation](https://lstein.github.io/PhotoMapAI/installation/).

### Windows

#### 1. Download and unpack the source code

Download the PhotoMap source code as a .zip file from the latest stable [Releases page](https://github.com/lstein/PhotoMapAI/releases). For development versions, use the "Download ZIP" link in the green "Code" button near the top of the GitHub PhotoMap home page.

Choose a convenient location in your home folder and unzip the file to create a new folder named `PhotoMap`.

#### 2. Run the installer script

Navigate to the unpacked `PhotoMap` folder, find the `INSTALL` folder, and double-click the `install_windows` script file. The system will check that Python and other requirements are installed, download the necessary library files, and create a .bat script named `start_photomap`.

#### 3. [Optional] Install Microsoft C++ Runtime DLLs

Several of PhotoMapAI's dependencies require Microsoft
C++ Runtime DLLs. If these are not present, the installer will
attempt to download and install them on your behalf. You will need to relaunch the install script after this is done.

#### 4. Start the server

Double-click `start_photomap.bat` to launch the server. You should see a few startup messages, followed by the URL for the running server.

#### 5. **Open your browser:**

Navigate to `http://localhost:8050` and follow the prompts to create and populate your first album.

---

### Linux & Mac

#### 1. Download and unpack the source code

Download the PhotoMap source code as a .zip file from the latest stable [Releases page](https://github.com/lstein/PhotoMapAI/releases). For development versions, use the "Download ZIP" link in the green "Code" button near the top of the GitHub PhotoMap home page.

Choose a convenient location in your home or downloads directory and unzip the file to create a new folder named `PhotoMap-X.X.X` (where X.X.X is the current release).

#### 2. Run the installer script

Launch a command line shell ("Terminal" on the Mac) and navigate to the `PhotoMap-X.X.X` folder. Launch the `INSTALL/install_linux_mac.sh` shell script file. The script will check that Python and other requirements are installed, download the necessary library files, and create a launcher script named `start_photomap` on your desktop. If you are uncomfortable with the command line, here are the commands you need:

```
cd ~/Downloads/PhotoMap-X.X.X/INSTALL
/bin/sh install_linux_mac.sh
```

#### 3. Start the server

Double click `start_photomap` to launch the server. You will see a few startup messages followed by the URL for the running server.

#### 4. **Open your browser:**

Navigate to `http://localhost:8050` and follow the prompts to create and populate your first album.

### Manual Install

Follow these instructions if you are comfortable with installing Python packages on the command line.

#### Mac/Linux

Make sure that your version of Python is between 3.10 and 3.13. Other versions are not guaranteed to work.

python3 -m venv ~/photomap --prompt photomap
source ~/photomap/bin/activate
python3 -m pip install --upgrade pip
pip install photomapai
start_photomap

Then open your web browser and point it to [http://127.0.0.1:8050](http://128.0.0.1:8050). Follow the prompts to create your first album.

#### Windows

Make sure that your version of Python is between 3.10 and 3.13. Other versions are not guaranteed to work. Also make sure that Python is on your PATH.

python3 -m venv C:\Users\<your name>\Documents\photomap --prompt photomap
C:\Users\<your name>\Documents\photomap\Scripts\activate
python3 -m pip install --upgrade pip
pip install photomapai
start_photomap

Then open your web browser and point it to [http://127.0.0.1:8050](http://128.0.0.1:8050). Follow the prompts to create your first album.

## Detailed Guides

- [Installation](https://lstein.github.io/PhotoMapAI/installation/)
- [User Guide](https://lstein.github.io/PhotoMapAI/user-guide/basic-usage/)
- [Configuration](https://lstein.github.io/PhotoMapAI/user-guide/configuration/)
- [Developer Guide](https://lstein.github.io/PhotoMapAI/developer/architecture.md)
- [Troubleshooting](https://lstein.github.io/PhotoMapAI/)
