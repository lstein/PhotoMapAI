# Installation

PhotoMap is a [Python](https://www.python.org/)-based web application that uses the [CLIP image recognition](https://openai.com/index/clip/) AI model to identify similarities among images, as well as to enable text- and image-similarity searching. It runs completely on your local system, and does not make calls out to internet-based AI systems.

## Hardware Requirements

* **Operating System**: Any recent (post-2020) version of Windows, Linux or MacOS.
* **RAM**: 8+ GB RAM recommended
* **Disk**: 6 GB free for the application and its dependencies, exclusive of the space needed for your photo/image collection.
* **CPU**: Any recent (post-2020) Intel or Apple CPU.
* **GPU**: NVidia graphics card (optional)

If an NVidia graphics card is available, then PhotoMap will take advantage of it during the initial indexing of your photo collection for a 10x increase in indexing speed. You may need to install additional libraries to take advantage of this feature as described below.

PhotoMap will take advantage of the built-in GPU acceleration on Apple M1, M2 and M3 chips.

## Installing Prerequisites

Before installing PhotoMap, you'll need to install Python and optionally CUDA.

- [Python](/installation/python/)
- [CUDA](/installation/cuda/) *Only if you need NVidia GPU card support*

Now follow the installation directions for [Linux & MacOS](#linux-&-macos) or [Windows](#windows)

## Linux & MacOS

### 1. Download and unpack the source code

Download the PhotoMap source code as a .zip file from the latest stable Releases page. For development versions, use the "Download ZIP" link in the green "Code" button near the top of the GitHub PhotoMap home page.

Choose a convenient location in your home directory and unzip the file to create a new folder named `PhotoMap`.

### 2. In a command line window, enter the PhotoMap folder and run the `pip` (Python package installer) command to create a home for the PhotoMap executable and library files:

```bash
cd ~/PhotoMap
pip -mvenv Executables --prompt photomap
```

### 3. Activate the folder for installation:

```bash
source Executables/bin/activate
```

Your system prompt should change to read `(photomap)` at this point.

### 4. Install PhotoMap and its libraries:

```bash
pip install .
```

This will download and install all the libraries that PhotoMap requires. Depending on your internet speed, this may take a while.

### 5. Launch the PhotoMap application.

If installation completed without errors, launch the PhotoMap server with the `start_photomap` command:

```bash
start_photomap
```

You should see a few startup messages, followed by the URL for the running server. Cut and paste this into your browser, and follow the prompts to configure and index your first album. See [Albums](../user-guide/albums) for a walkthrough.

### 6. Exiting and relaunching

To exit the server, press ^C (control-C). 

To launch it again, you may (re)activate the Executables folder:

```bash
source Executables/bin/activate
start_photomap
```

Alternatively, you can run it directly from its folder:

```bash
./Executables/bin/start_photomap
```

Or just use the file browser to navigate to the `start_photomap` script and double-click it!

## Windows

### 1. Download and unpack the source code

Download the PhotoMap source code as a .zip file from the latest stable Releases page. For development versions, use the "Download ZIP" link in the green "Code" button near the top of the GitHub PhotoMap home page.

Choose a convenient location in your home directory and unzip the file to create a new folder named `PhotoMap`.

### 2. Run the installer script

Open a Powershell command-line window, navigate to `PhotoMap`, find the `installation` folder, and double-click the `install_windows` script file. The system will check that Python and other requirements are installed, download the necessary library files, and create a .bat script named `start_photomap`.

### 3. Start the server

Double-click `start_photomap.bat` to launch the server. You should see a few startup messages, followed by the URL for the running server. Cut and paste this into your browser, and follow the prompts to configure and index your first album. See [Albums](../user-guide/albums) for a walkthrough.

### 4. Exiting and relaunching

To exit the server, press ^C (control-C). 

To relaunch the server, run the `start_photomap` .bat script again. For your convenience, you may move this script anywhere you like. However, don't move the PhotoMap directory!


