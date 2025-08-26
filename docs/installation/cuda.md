# Installing CUDA

CUDA library versions 12.6 through 12.9 are required to take advantage of GPU acceleration on NVidia graphics cards. Acceleration will dramatically speed up indexing of your photo collection by about 10X. After the index is built, GPU acceleration offers only a modest increase in performance when searching image content by text or image similarity. Note that CUDA is **not** available (or required) for MacOS systems.

CUDA version 13 is not currently supported by the AI libraries underlying PhotoMapAI.

## Steps to Install CUDA

### 1. First test whether CUDA is already installed:

Open a command window and type the command `nvidia-smi`:

```bash
PS C:\Users\username> nvidia-smi
Mon Aug 11 21:33:57 2025       
+---------------------------------------------------------------------------------------+
| NVIDIA-SMI 535.230.02             Driver Version: 535.230.02   CUDA Version: 12.9     |
|-----------------------------------------+----------------------+----------------------+
(more information follows)
```
If this runs and prints out CUDA Version 12.6-12.9 or higher, then you're all done and can skip the rest of this section.

### 2. Install CUDA from NVIDIA.

Go to the [CUDA 12.9 Download Page](https://developer.nvidia.com/cuda-12-9-0-download-archive) and choose your operating system, architecture, and OS version. Select either the "local" or "network" installer. Download the installer, run it, and follow the on-screen prompts.

### 3. Confirm that CUDA is installed.

In a command shell, run the `nvidia-smi` command as in (1) and confirm that the expected version is installed.

### 4. Re-run the PhotoMapAI installer (Windows only).

If you are on a Windows platform, please follow the [PhotoMapAI Installation](../installation.md) instructions to update the Torch machine learning library for CUDA support. The easiest path is to run the [installer script](../installation.md#2-run-the-installer-script) again, and provide it with the same installation path you chose for the original install. Alternatively, you may [manually install](../installation.md#manual-installation) the CUDA version of Torch.

To confirm that CUDA support is enabled, look for a console message about GPU acceleration when PhotoMapAI first launches.


