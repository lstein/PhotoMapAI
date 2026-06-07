# Installation

PhotoMapAI is a [Python](https://www.python.org/)-based web application that uses the [CLIP image recognition](https://openai.com/index/clip/) AI model to identify similarities among images, as well as to enable text- and image-similarity searching. It runs completely on your local system, and does not make calls out to internet-based AI systems.

## Hardware Requirements

* **Operating System**: Any recent (post-2020) version of Windows, Linux or MacOS.
* **RAM**: 8+ GB RAM recommended
* **Disk**: 6 GB free for the application and its dependencies, exclusive of the space needed for your photo/image collection.
* **CPU**: Any recent (post-2020) Intel or Apple CPU.
* **GPU**: NVidia graphics card (optional)

If an NVidia graphics card is available, PhotoMapAI uses it during the initial indexing of your photo collection for roughly a 10x speedup. The installer handles this for you automatically (see [GPU acceleration](#gpu-acceleration)). PhotoMapAI also uses the built-in GPU acceleration on Apple M-series chips.

---

## Recommended: the desktop installer

The easiest way to install PhotoMapAI is the native installer for your platform. **You do not need to install Python, CUDA, or anything else first** — the installer sets up everything on first launch.

Download the file for your platform from the latest [release page](https://github.com/lstein/PhotoMapAI/releases) (under **Assets**), where `X.X.X` is the current version:

| Platform | Download | Install |
|----------|----------|---------|
| **macOS** | `PhotoMapAI-X.X.X.dmg` | Open the `.dmg` and drag **PhotoMapAI** to **Applications** |
| **Windows** | `PhotoMapAI-X.X.X-setup.exe` | Run the installer (no administrator rights needed) |
| **Linux** | `PhotoMapAI-X.X.X-x86_64.AppImage` | Make it executable (`chmod +x`) and double-click, or run it from a terminal |

### First launch

The first time you start PhotoMapAI, it downloads a private copy of Python and the AI libraries it needs. **This is a multi-gigabyte, one-time download that can take several minutes** — a console window shows the progress. When it finishes, the server starts and your web browser opens to the app automatically.

Every later launch skips that step and starts in a second or two.

Everything the installer downloads lives in a single per-user folder, so uninstalling is clean (see [Uninstalling](#uninstalling)). Your albums and settings are stored separately and are preserved across upgrades and reinstalls.

### GPU acceleration

On first run the installer auto-detects an NVIDIA GPU and installs the matching GPU-accelerated libraries; if there's no GPU it installs the CPU version. Apple Silicon acceleration is automatic. You normally don't need to do anything.

If you need to override the automatic choice (for example you added a GPU later, or want to force CPU mode), launch the app from a terminal with a flag:

```bash
# macOS app:   PhotoMapAI.app/Contents/Resources/photomap
# Windows:     %LOCALAPPDATA%\Programs\PhotoMapAI\photomap.exe
# Linux:       ./PhotoMapAI-X.X.X-x86_64.AppImage

photomap --gpu     # re-detect and use an NVIDIA GPU
photomap --cpu     # force the CPU-only build
```

### Security warnings

The macOS and Windows installers are code-signed, so they should open without warnings. On Windows, a brand-new release may still briefly show a SmartScreen "Windows protected your PC" prompt until the download builds reputation — click **More info → Run anyway**. On Linux, AppImages are not signed; just make the file executable.

### Uninstalling

- **Windows:** uninstall "PhotoMapAI" from *Settings → Apps*.
- **macOS:** drag **PhotoMapAI** from Applications to the Trash.
- **Linux:** delete the `.AppImage`.

To also remove the downloaded Python/libraries, run `photomap --uninstall` (paths above) before deleting the app, or delete the runtime folder manually:

| OS | Runtime folder |
|----|----------------|
| Windows | `%LOCALAPPDATA%\PhotoMapAI` |
| macOS | `~/Library/Application Support/PhotoMapAI` |
| Linux | `~/.local/share/PhotoMapAI` |

---

## Alternative: install from PyPI

If you are comfortable with the command line and already have Python 3.10–3.14, you can install the package directly. We recommend [uv](https://docs.astral.sh/uv/):

```bash
uv tool install photomapai --torch-backend auto
start_photomap
```

`--torch-backend auto` picks GPU or CPU PyTorch automatically. Or with plain `pip` in a virtual environment:

```bash
python -m venv photomap --prompt photomap
source photomap/bin/activate          # Windows: photomap\Scripts\activate
pip install --upgrade pip
pip install photomapai
start_photomap
```

After the startup messages, your browser opens to `http://localhost:8050` automatically. (Pass `--no-browser`, or set `PHOTOMAP_NO_BROWSER=1`, to suppress that.)

---

## Alternative: Docker

If you have Docker installed:

```bash
docker run -p 8050:8050 -v /path/to/a/picture_folder:/Pictures lstein/photomapai:latest
```

Change `/path/to/a/picture_folder` to a folder of images you want to browse, then point your browser to `http://localhost:8050`. Your images appear in the container directory `/Pictures`.

---

## Manual installation from source

Download and unpack the source from the [release page](https://github.com/lstein/PhotoMapAI/releases), then:

```bash
cd PhotoMapAI
python -m venv .venv --prompt photomap
source .venv/bin/activate             # Windows: .venv\Scripts\activate
pip install --upgrade pip
pip install .
start_photomap
```

If you have an NVidia card on Windows and want GPU acceleration, install a CUDA build of PyTorch first (see [CUDA](installation/cuda.md)); on Linux and macOS this is handled automatically. To start the server again later, re-run `start_photomap` from the activated environment.
