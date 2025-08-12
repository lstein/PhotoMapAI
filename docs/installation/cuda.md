# Installing CUDA

CUDA library versions 12.6 through 12.9 are required to take advantage of GPU acceleration on NVidia graphics cards. Acceleration will dramatically speed up indexing of your photo collection by about 10X. After the index is built, GPU acceleration offers only a modest increase in performance when searching image content by text or image similarity. Note that CUDA is **not** available (or required) for MacOS systems.

CUDA version 13 is not currently supported by the AI libraries underlying PhotoMap.

## Steps to Install CUDA

### 1. First test whether CUDA is already installed:

Open a command window and type the command:

```bash
nvidia-smi
Mon Aug 11 21:33:57 2025       
+---------------------------------------------------------------------------------------+
| NVIDIA-SMI 535.230.02             Driver Version: 535.230.02   CUDA Version: 12.6     |
|-----------------------------------------+----------------------+----------------------+
(more information follows)
```
If this runs and prints out CUDA Version 12.6-12.9 or higher, then you're all done and can skip the rest of this section.

### 2. Install CUDA from NVIDIA.

Go to the [CUDA 12.9 Download Page](https://developer.nvidia.com/cuda-12-9-0-download-archive) and choose your operating system, architecture, and OS version. Select either the "local" or "network" installer. Download the installer, run it, and follow the on-screen prompts.

### 3. Confirm that CUDA is installed.

In a command shell, run the `nvidia-smi` command as in (1) and confirm that the expected version is installed.

[PhotoMap Installation](../installation/)

