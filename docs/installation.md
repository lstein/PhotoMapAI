# Installation

PhotoMapAI is a [Python](https://www.python.org/)-based web application that uses the [CLIP image recognition](https://openai.com/index/clip/) AI model to identify similarities among images, as well as to enable text- and image-similarity searching. It runs completely on your local system, and does not make calls out to internet-based AI systems.

## Hardware Requirements

* **Operating System**: Any recent (post-2020) version of Windows, Linux or MacOS.
* **RAM**: 8+ GB RAM recommended
* **Disk**: 6 GB free for the application and its dependencies, exclusive of the space needed for your photo/image collection.
* **CPU**: Any recent (post-2020) Intel or Apple CPU.
* **GPU**: NVidia graphics card (optional)

If an NVidia graphics card is available, then PhotoMapAI will take advantage of it during the initial indexing of your photo collection for a 10x increase in indexing speed. You may need to install additional libraries to take advantage of this feature as described below.

PhotoMapAI will take advantage of the built-in GPU acceleration on Apple M1, M2 and M3 chips.

## Installing Prerequisites

Before installing PhotoMapAI, you'll need to install Python and optionally CUDA.

- [Python](installation/python.md)
- [CUDA](installation/cuda.md) (*Only if you need NVidia GPU card support*)

After the preqrequisites are installed, follow the installation directions for [Linux & MacOS](#linux-macos) or [Windows](#windows). For those who are comfortable with the command shell, there are also instructions for [Manual Installs](#manual-installation)

---


## Windows

### 1. Download and unpack the source code

Download the PhotoMapAI source code as a .zip file from the latest stable Releases page. For development versions, use the "Download ZIP" link in the green "Code" button near the top of the GitHub PhotoMapAI home page.

Choose a convenient location in your home folder and unzip the file to create a new folder named `PhotoMapAI`.

### 2. Run the installer script

Navigate to the unpacked `PhotoMapAI` folder, find the `INSTALL` folder, and double-click the `install_windows` script file. The system will check that Python and other requirements are installed, download the necessary library files, and create a .bat script named `start_photomap`.

### 3. [Optional] Install Microsoft C++ Runtime DLLs

Several of PhotoMapAI's dependencies require Microsoft
C++ Runtime DLLs. If these are not present, the installer will
attempt to download and install them on your behalf. You will need to relaunch the install script after this is done.

### 4. Start the server

Double-click `start_photomap.bat` to launch the server. You should see a few startup messages, followed by the URL for the running server. Cut and paste this into your browser, and follow the prompts to configure and index your first album. See [Albums](user-guide/albums.md) for a walkthrough.

### 5. Exiting and relaunching

To exit the server, press ^C (control-C). 

To relaunch the server, run the `start_photomap` .bat script again. For your convenience, you may move this script anywhere you like. Don't move the PhotoMapAI folder, or the script will not be able to find it again. If this happens, simply re-run the installer script to generate an updated launcher.

---

## Linux & MacOS

### 1. Download and unpack the source code

Download the PhotoMapAI source code as a .zip file from the latest stable Releases page. For development versions, use the "Download ZIP" link in the green "Code" button near the top of the GitHub PhotoMapAI home page.

Choose a convenient location in your home directory and unzip the file to create a new folder named `PhotoMapAI`.

### 2. Run the installer script

Navigate to the `PhotoMapAI` folder and launch the `install_linux_mac` shell script file. The script will check that Python and other requirements are installed, download the necessary library files, and create a launcher script named `start_photomap` on your desktop.

### 3. Start the server

Double click `start_photomap` to launch the server. You will see a few startup messages followed by the URL for the running server. Cut and paste this into your browser and follow the prompts to configure and index your first album. See [Albums](user-guide/albums.md) for a walkthrough.

### 4. Exiting and relaunching

To exit the server, press ^C (control-C). 

To relaunch the server, run the `start_photomap` launcher again. For your convenience, you may move this script anywhere you like. If you move the PhotoMapAI folder itself, you will need to re-run the installer script.

---

## Manual Installation

Download and unpack the source code as described in the sections above. Then follow these steps:

### 1. Create an installation directory for the executables

In a command line window, enter the PhotoMapAI folder and run the `pip` (Python package installer) command to create a home for the PhotoMapAI executable and library files:

```bash
cd ~/PhotoMapAI
pip -mvenv install --prompt photomap
```

### 2. Activate the folder for installation:

```bash
source install/bin/activate
```

Your system prompt should change to read `(photomap)` at this point.

### 3. Install PhotoMapAI and its libraries:

```bash
pip install .
```

This will download and install all the libraries that PhotoMapAI requires. Depending on your internet speed, this may take a while.

### 4. Launch the PhotoMapAI application.

If installation completed without errors, launch the PhotoMapAI server with the `start_photomap` command:

```bash
start_photomap
```

You should see a few startup messages, followed by the URL for the running server. Cut and paste this into your browser, and follow the prompts to configure and index your first album. See [Albums](user-guide/albums.md) for a walkthrough.

### 5. Exiting and relaunching

To exit the server, press ^C (control-C). 

To launch the server again, run its executable.

On Windows:

```bash
C:\path\to\PhotoMapAI\install\scripts\start_photomap.exe
```

On Linux/MacOS:

```
bash
/path/to/PhotoMapAI/install/bin/start_photomap
```

You can also just use the file browser to navigate to the `start_photomap` executable and double-click it.
