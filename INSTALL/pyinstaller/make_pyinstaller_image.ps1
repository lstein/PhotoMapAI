<#
.SYNOPSIS
    Build a PyInstaller executable for PhotoMap on Windows.
.DESCRIPTION
    Usage: .\make_pyinstaller_image.ps1 [cpu|cu121|cu118|cu124|cu129|...]
    - cpu      : Install CPU-only PyTorch (default)
    - cuXXX    : Install CUDA-enabled PyTorch (e.g., cu121 for CUDA 12.1)
#>

param(
    [string]$TorchVariant = "cpu"
)

function Show-Usage {
    Write-Host "Usage: .\make_pyinstaller_image.ps1 [cpu|cu121|cu118|cu124|cu129|...]"
    Write-Host "  cpu      - Install CPU-only PyTorch (default)"
    Write-Host "  cuXXX    - Install CUDA-enabled PyTorch (e.g., cu121 for CUDA 12.1)"
    exit 1
}

Write-Host "Requested PyTorch variant: $TorchVariant"

switch ($TorchVariant) {
    "cpu" {
        pip install torch torchvision -U --index-url https://download.pytorch.org/whl/cpu
    }
    { $_ -match "^cu\d+$" } {
        pip install torch torchvision -U --index-url "https://download.pytorch.org/whl/$TorchVariant"
    }
    Default { Show-Usage }
}

# Upgrade build tools and hooks
python -m pip install -U pip wheel setuptools
python -m pip install -U pyinstaller pyinstaller-hooks-contrib

# Install runtime dependencies
python -m pip install -U numpy pillow scikit-learn

# Install CLIP and your package
pip install clip-anytorch
pip install .

Write-Host "Installing CLIP model..."
python -c "import clip; clip.load('ViT-B/32')"

# to permit testing on non-windows platforms
if ($IsWindows) {
    $sep = ";"
} else {
    $sep = ":"
}

# Run PyInstaller
pyinstaller `
    --hidden-import clip `
    --hidden-import numpy `
    --hidden-import torch `
    --hidden-import torchvision `
    --hidden-import photomap `
    --hidden-import photomap.backend `
    --hidden-import photomap.backend.photomap_server `
    --hidden-import photomap.backend.main_wrapper `
    --hidden-import photomap.backend.routers `
    --hidden-import photomap.backend.routers.album `
    --hidden-import photomap.backend.routers.search `
    --hidden-import photomap.backend.embeddings `
    --hidden-import photomap.backend.config `
    --hidden-import uvicorn `
    --hidden-import fastapi `
    --collect-all torch `
    --collect-all torchvision `
    --collect-all clip `
    --collect-all numpy `
    --collect-all sklearn `
    --collect-all PIL `
    --collect-all photomap `
    --add-data "$(python -c "import clip; print(clip.__path__[0])"):clip" `
    --add-data "$env:USERPROFILE/.cache/clip${sep}clip_models" `
    --add-data "photomap/frontend/static${sep}photomap/frontend/static" `
    --add-data "photomap/frontend/templates${sep}photomap/frontend/templates" `
    --paths . `
    --onefile `
    --name "photomap-$TorchVariant" `
    -y `
    photomap/backend/photomap_server.py