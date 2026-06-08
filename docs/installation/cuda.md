# NVIDIA GPU Acceleration

If your computer has an NVIDIA graphics card, PhotoMapAI can use it to speed up
the initial indexing of your photo collection by roughly **10x**. (After the
index is built, the GPU offers only a modest speedup for text- and
image-similarity searches.)

## You do **not** need to install CUDA

This is the part that surprises most people: **you do not need to download or
install the CUDA Toolkit from NVIDIA.** PhotoMapAI installs its own copy of
PyTorch, and the GPU build of PyTorch already bundles every CUDA runtime library
it needs (the CUDA runtime, cuDNN, cuBLAS, and so on). This is true on **both
Windows and Linux** — there is no difference between the two platforms here.

The one thing PhotoMapAI cannot bundle is the **NVIDIA graphics driver**, because
that talks directly to your hardware. So the *only* GPU prerequisite is a
reasonably recent NVIDIA driver. If you can play modern games or already use your
card for anything graphics-intensive, you almost certainly have it.

> **macOS:** CUDA is neither available nor required. PhotoMapAI automatically uses
> the built-in GPU acceleration on Apple M-series chips. You can ignore this page.

## Check whether your system is ready

Open a command window — PowerShell or Command Prompt on Windows, Terminal on
Linux — and run:

```bash
nvidia-smi
```

If it prints a table like this, **you're ready** — there is nothing else to install:

```text
+---------------------------------------------------------------------------------------+
| NVIDIA-SMI 535.230.02             Driver Version: 535.230.02   CUDA Version: 13.0     |
|-----------------------------------------+----------------------+----------------------+
(more information follows)
```

Two things to notice:

- `nvidia-smi` ships **with the driver**, not with the CUDA Toolkit. The fact that
  it runs at all means the driver is installed and working — which is exactly (and
  only) what PhotoMapAI needs.
- The **"CUDA Version"** in the top-right is the highest CUDA version your
  *driver* can support — **not** a toolkit you have to install. Make sure it reads
  **12.x or newer** (current PyTorch builds target CUDA 12 and 13). Anything in
  that range works.

If `nvidia-smi` runs and shows your card, skip the rest of this page.

## If `nvidia-smi` is not found

That means the NVIDIA **driver** isn't installed (you still do not need the CUDA
Toolkit). Install just the driver:

### Windows

Most Windows machines with an NVIDIA card already have the driver via Windows
Update or GeForce Experience. If not, download the latest **Game Ready** or
**Studio** driver from
[nvidia.com/drivers](https://www.nvidia.com/download/index.aspx), install it, and
run `nvidia-smi` again.

### Linux (Ubuntu / Mint and similar)

A fresh Linux install boots with the open-source `nouveau` driver, so `nvidia-smi`
won't exist until you install NVIDIA's proprietary driver. On Ubuntu/Mint, use any
one of:

```bash
# easiest: let the distro pick the right driver
sudo ubuntu-drivers autoinstall

# or install a specific version
sudo apt install nvidia-driver-550        # use the version offered by your distro
```

Mint and Ubuntu also expose this through the **"Additional Drivers"** /
**"Driver Manager"** GUI. Reboot, then run `nvidia-smi` to confirm. Again — this
installs the *driver*, not the CUDA Toolkit.

## Telling PhotoMapAI to use the GPU

- **Desktop installer:** nothing to do. On first launch PhotoMapAI auto-detects
  the GPU and installs the GPU build of PyTorch for you. If you add a card later
  (or want to force a re-detect), launch with the `--gpu` flag — see
  [GPU acceleration](../installation.md#gpu-acceleration) in the main installation
  guide.
- **PyPI / `uv`:** `uv tool install photomapai --torch-backend auto` picks the GPU
  or CPU build of PyTorch automatically based on what `nvidia-smi` reports.

To confirm GPU support is active, watch for a console message about GPU
acceleration when PhotoMapAI starts up.
