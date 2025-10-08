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

After the preqrequisites are installed, follow the installation directions for [Linux & MacOS](#linux-macos) or [Windows](#windows). For those who are comfortable with the command shell, there are also instructions for [Manual Install](#manual-installation) and [Docker Install](#docker-install).

Finally, there are a series of experimental double-click executables for all three platforms. See [Executable Install](#executable-install) for details.

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

Choose a convenient location in your Downloads directory and unzip the file to create a new folder named `PhotoMapAI-X.X.X`, where X.X.X is the current release number

### 2. Run the installer script

Launch a command-line shell ("Terminal" on the Mac) and navigate to the `PhotoMap-X.X.X` folder. Launch the `INSTALL/install_linux_mac.sh` shell script file. The script will check that Python and other requirements are installed, download the necessary library files, and create a launcher script named `start_photomap` on your desktop. If you are uncomfortable with the command line, here are the commands you need:

```
cd ~/Downloads/PhotoMap-X.X.X/INSTALL
/bin/sh install_linux_mac.sh
```

### 3. Start the server

Double click `start_photomap` to launch the server. You will see a few startup messages followed by the URL for the running server. Cut and paste this into your browser and follow the prompts to configure and index your first album. See [Albums](user-guide/albums.md) for a walkthrough.

### 4. Exiting and relaunching

To exit the server, press ^C (control-C). 

To relaunch the server, run the `start_photomap` launcher again. For your convenience, you may move this script anywhere you like. If you move the PhotoMapAI folder itself, you will need to re-run the installer script.

---

## PyPi  Installation

If you are familiar with installing Python packages, here is a quick recipe:

```bash
python -mvenv photomap --prompt photomap
source photomap/bin/activate
pip install --upgrade pip
pip install photomapai
start_photomap
```

After the startup messages, point your browser to http://localhost:8050 and follow the prompts.

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

### 3. Install a CUDA enabled version of PyTorch (Optional: Windows only)

If you have an NVidia graphics card, are installing on a Windows machine, and have the [CUDA Library](installation/cuda.md) installed, you can take advantage of GPU acceleration by installing a CUDA-enabled version of the PyTorch machine learning library used by PhotoMapAI during photo indexing. *This step is not required for Linux or Macintosh systems, which will take advantage of GPU hardware acceleration automatically.*

Go to https://pytorch.org/get-started/locally/ and use the version selector to choose the version of PyTorch that matches your CUDA library version. Then issue the recommended installation command, e.g.

```bash
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu129
```

If you initially installed the CPU-only version of PyTorch, don't despair. You can come back and install CUDA PyTorch at any time.

### 4. Install PhotoMapAI and its libraries:

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

---

### Docker Install

If you have Docker installed on your system, here is a one-liner to get PhotoMapAI up and running:

```bash
docker -p 8050:8050 -v /path/to/a/picture_folder:/Pictures lstein/photomapai:latest
```
Change `/path/to/a/picture_folder` to a path on your desktop that contains the images/photos you wish to add to an album. After the startup messages, point your browser to http://localhost:8050 and follow the prompts. Your images will be found in the container directory `/Pictures`.

---

## Executable Install

As of version 0.9.4, there is also an option to install a prebuilt executable package. This package does not require you to install Python, CUDA, or any other PhotoMapAI dependencies. However, the executable is not yet code-signed, meaning that Windows and Mac users will have to bypass code safety checks.

Go to the latest [release page](https://github.com/lstein/PhotoMapAI/releases) and look under **assets**. There you will find the following files, where X.X.X is replaced by the current released version number:

| Name                              | Platform            | GPU Acceleration |
|-----------------------------------|---------------------|--------------|
| photomap-linux-x64-cpu-vX.X.X.zip | Linux | none |
| photomap-linux-x64-cu129-vX.X.X.zip | Linux | CUDA 12.9 |
| photomap-macos-x64-cpu-vX.X.X.zip | Macintosh | built-in acceleration|
| photomap-windows-x64-cpu-vX.X.X.zip | Windows | none|
| photomap-windows-x64-cu129-vX.X.X.zip | Windows | CUDA 12.9|

If you have an Nvidia card and any of the CUDA 12.X libraries installed, you can take advantage of accelerated image indexing by choosing one of the `cu129` packages. Download the zip file for your platform and unpack it. Then follow these instructions to bypass the operating system's code-checking:

#### Mac

Using the command-line terminal, navigate to the unpacked folder `photomap-macos-x64-cpu-vX.X.X` and run this command:

```bash
xattr -d com.apple.quarantine ./photomap-macos-x64-cpu-vX.X.X`
```
(Use the actual version number, not X.X.X). This step only has to be done once.

Now you can double-click on the package and the PhotoMapAI server will launch in a terminal window after a brief delay.

#### Windows

After unpacking, navigate into the folder and double-click on `photomap.exe`. You will be warned that you are trying to run untrusted code. Click on the `More info` link, and choose `Run anyway`. After a short delay, a new terminal window will open up with the output from the PhotoMapAI server.

You'll need to override the untrusted code check each time you launch PhotoMapAI. 

#### Linux

Using the terminal/command-line shell, navigate to the unpacked folder and run `./photomap`. No trusted code workarounds are needed. If you prefer to double-click an icon, there is a `run_photomap.sh` script in the folder that will launch a terminal for you and run PhotoMapAI inside it.