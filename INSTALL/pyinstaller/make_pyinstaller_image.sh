#!/bin/bash
# filepath: /home/lstein/Projects/PhotoMap/INSTALL/pyinstaller/make_pyinstaller_image.sh

set -e

# Usage info
usage() {
    echo "Usage: $0 [cpu|cu121|cu118|cu124|cu129|...]"
    echo "  cpu      - Install CPU-only PyTorch (default)"
    echo "  cuXXX    - Install CUDA-enabled PyTorch (e.g., cu121 for CUDA 12.1)"
    exit 1
}

# Parse argument, default to "cpu" if not provided
TORCH_VARIANT="${1:-cpu}"

# Set PyInstaller mode based on torch variant
if [[ "$TORCH_VARIANT" == cpu ]]; then
    PYINSTALLER_MODE="--onefile"
else
    PYINSTALLER_MODE="--onedir"
fi

# Install appropriate PyTorch
echo "Requested PyTorch variant: $TORCH_VARIANT"
case "$TORCH_VARIANT" in
    cpu)
        pip install torch torchvision -U --index-url https://download.pytorch.org/whl/cpu
        ;;
    cu129|cu128|cu126|cu125|cu124|cu121|cu118)
        pip install torch torchvision -U --index-url https://download.pytorch.org/whl/$TORCH_VARIANT
        ;;
    *)
        echo "Unknown or unsupported variant: $TORCH_VARIANT"
        usage
        ;;
esac

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
    $PYINSTALLER_MODE \
    --argv-emulation \
    --name photomap \
    -y \
    photomap/backend/photomap_server.py