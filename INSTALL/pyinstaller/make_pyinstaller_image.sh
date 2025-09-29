#!/bin/bash
# filepath: /home/lstein/Projects/PhotoMap/INSTALL/pyinstaller/make_pyinstaller_image.sh

# Function to detect CUDA version
detect_cuda() {
    if command -v nvidia-smi &> /dev/null; then
        local nvidia_output=$(nvidia-smi 2>/dev/null)
        if [[ $nvidia_output ]]; then
            if [[ $nvidia_output =~ CUDA\ Version:\ ([0-9]+\.[0-9]+) ]]; then
                echo "${BASH_REMATCH[1]}"
                return 0
            fi
        fi
    fi
    return 1
}

# Check for CUDA and install appropriate PyTorch
echo "Checking for CUDA..."
cuda_version=$(detect_cuda)
if [[ $? -eq 0 ]]; then
    echo "CUDA Version $cuda_version detected."
    
    # Only support known CUDA versions for PyTorch wheels
    case "$cuda_version" in
        "12.9"|"12.8"|"12.6"|"12.5"|"12.4"|"12.1"|"11.8")
            cuda_suffix="cu${cuda_version//./}"
            echo "Using PyTorch wheel: $cuda_suffix"
            pip install torch torchvision --index-url https://download.pytorch.org/whl/$cuda_suffix
            ;;
        *)
            echo "CUDA version $cuda_version may not be fully supported. Installing CPU-only PyTorch..."
            pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
            ;;
    esac
else
    echo "No CUDA detected. Installing CPU-only PyTorch..."
    pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
fi

# Make sure build tools and hooks are up to date
python -m pip install -U pip wheel setuptools
python -m pip install -U pyinstaller pyinstaller-hooks-contrib

# Ensure runtime deps are installed in this venv before bundling
python -m pip install -U numpy pillow scikit-learn

# Load CLIP model in its cache (and your package)
pip install clip-anytorch
pip install .
echo "Installing CLIP model..."
python -c "import clip; clip.load('ViT-B/32')"

# Run PyInstaller
pyinstaller \
    --hidden-import clip \
    --hidden-import numpy \
    --hidden-import torch \
    --hidden-import torchvision \
    --hidden-import photomap \
    --hidden-import photomap.backend \
    --hidden-import photomap.backend.photomap_server \
    --hidden-import photomap.backend.main_wrapper \
    --hidden-import photomap.backend.routers \
    --hidden-import photomap.backend.routers.album \
    --hidden-import photomap.backend.routers.search \
    --hidden-import photomap.backend.embeddings \
    --hidden-import photomap.backend.config \
    --hidden-import uvicorn \
    --hidden-import fastapi \
    --collect-all torch \
    --collect-all torchvision \
    --collect-all clip \
    --collect-all numpy \
    --collect-all sklearn \
    --collect-all PIL \
    --collect-all photomap \
    --add-data "$(python -c "import clip; print(clip.__path__[0])"):clip" \
    --add-data "$HOME/.cache/clip:clip_models" \
    --add-data "photomap/frontend/static:photomap/frontend/static" \
    --add-data "photomap/frontend/templates:photomap/frontend/templates" \
    --paths . \
    --onefile \
    --argv-emulation \
    --name photomap \
    -y \
    photomap/backend/photomap_server.py