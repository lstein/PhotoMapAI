#!/bin/bash
# filepath: /home/lstein/Projects/PhotoMap/INSTALL/pyinstaller/make_pyinstaller_image.sh

set -e

# Usage info
usage() {
    echo "Usage: $0 [cpu|cu121|cu118|cu124|cu129|...] [--macos-app]"
    echo "  cpu      - Install CPU-only PyTorch (default)"
    echo "  cuXXX    - Install CUDA-enabled PyTorch (e.g., cu121 for CUDA 12.1)"
    echo "  --macos-app - Create macOS .app bundle (macOS only)"
    exit 1
}

# Parse arguments
TORCH_VARIANT="${1:-cpu}"
MACOS_APP=false

# Check for --macos-app flag
for arg in "$@"; do
    case $arg in
        --macos-app)
            MACOS_APP=true
            shift
            ;;
    esac
done

# Validate macOS app option
if [[ "$MACOS_APP" == true && "$(uname)" != "Darwin" ]]; then
    echo "Error: --macos-app option can only be used on macOS"
    exit 1
fi

# Set PyInstaller mode based on torch variant and platform
if [[ "$MACOS_APP" == true ]]; then
    PYINSTALLER_MODE=""
elif [[ "$TORCH_VARIANT" == cpu ]]; then
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

# After installing PyTorch
pip cache purge
python -c "import torch; print(f'PyTorch cache cleared')"

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

# Prepare PyInstaller arguments
PYINSTALLER_ARGS=(
    --hidden-import clip
    --hidden-import numpy
    --hidden-import torch
    --hidden-import torchvision
    --hidden-import photomap
    --hidden-import photomap.backend
    --hidden-import photomap.backend.photomap_server
    --hidden-import photomap.backend.main_wrapper
    --hidden-import photomap.backend.routers
    --hidden-import photomap.backend.routers.album
    --hidden-import photomap.backend.routers.search
    --hidden-import photomap.backend.embeddings
    --hidden-import photomap.backend.config
    --hidden-import uvicorn
    --hidden-import fastapi
    --collect-all torch
    --collect-all torchvision
    --collect-all clip
    --collect-all numpy
    --collect-all sklearn
    --collect-all PIL
    --collect-all photomap
    --add-data "$(python -c "import clip; print(clip.__path__[0])"):clip"
    --add-data "$HOME/.cache/clip:clip_models"
    --add-data "photomap/frontend/static:photomap/frontend/static"
    --add-data "photomap/frontend/templates:photomap/frontend/templates"
    --paths .
    $PYINSTALLER_MODE
    --argv-emulation
    --name photomap
    -y
)

# Add macOS-specific options if building app bundle
if [[ "$MACOS_APP" == true ]]; then
    PYINSTALLER_ARGS+=(
        --osx-bundle-identifier org.4crabs.photomap
        --icon photomap/frontend/static/icons/icon.icns
    )
    echo "Building macOS .app bundle..."
else
    echo "Building standard executable..."
fi

# Run PyInstaller
pyinstaller "${PYINSTALLER_ARGS[@]}" photomap/backend/photomap_server.py

# Before running PyInstaller
echo "Disk space before PyInstaller:"
df -h

# After PyInstaller
rm -rf build/  # Remove PyInstaller temp files

# Remove unpacked directory if building macOS app bundle
if [[ "$MACOS_APP" == true ]]; then
    if [ -d dist/photomap ]; then
        rm -rf dist/photomap
    fi
    echo "✅ macOS app bundle created: dist/photomap.app"
    echo "Users can double-click photomap.app to launch PhotoMap"
else
    echo "✅ Executable created in dist/ directory"
fi