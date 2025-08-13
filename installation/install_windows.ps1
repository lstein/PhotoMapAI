
# 1. Check Python version 
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    Write-Host "Python is not installed. Please install Python 3.8 or higher from https://www.python.org/downloads/windows/" -ForegroundColor Red
    exit 1
}

$version = python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
if ([version]$version -lt [version]"3.8") {
    Write-Host "Python version $version found. Please install Python 3.8 or higher from https://www.python.org/downloads/windows/" -ForegroundColor Red
    exit 1
}

# 2. Check whether CUDA is installed
$cuda_installed = $false
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
    $cuda_installed = $true
}

# 2. Set default install location to AppData\Local\Programs\photomap
$envUser = $env:USERNAME
$defaultInstallDir = "C:\Users\$envUser\AppData\Local\Programs\PhotoMap"

$installDir = Read-Host "Enter install location for PhotoMap virtual environment [$defaultInstallDir]"

if ([string]::IsNullOrWhiteSpace($installDir)) {
    $installDir = $defaultInstallDir
}

# Ensure the directory exists
if (-not (Test-Path $installDir)) {
    Write-Host "Creating directory $installDir ..."
    New-Item -ItemType Directory -Path $installDir | Out-Null
}

Set-Location $installDir

# 3. Create virtual environment in .venv
Write-Host "Creating virtual environment in $installDir\.venv ..."
python -m venv .venv

# 4. Activate virtual environment and install PhotoMap
$venvActivate = ".\.venv\Scripts\Activate.ps1"
if (-not (Test-Path $venvActivate)) {
    Write-Host "Failed to create virtual environment. Exiting." -ForegroundColor Red
    exit 1
}

Write-Host "Activating virtual environment and installing PhotoMap..."
& $venvActivate
pip install --upgrade pip
if ($cuda_installed) {
    Write-Host "CUDA detected. Installing PyTorch with CUDA support..." -ForegroundColor Green
    pip install torch torchvision --index-url https://download.pytorch.org/whl/cu129
}
pip install "$PSScriptRoot"

# 5. Print out instructions for running start_photomap
# $slideshowPath = Resolve-Path .\.venv\Scripts\start_slideshow.exe
# Write-Host "`nPhotoMap installed successfully in $installDir!" -ForegroundColor Green
# Write-Host "To start the slideshow, run:" -ForegroundColor Yellow
# Write-Host "`n    $slideshowPath`n" -ForegroundColor Cyan
# Write-Host "Or, if your shell is not activated, run:" -ForegroundColor Yellow
# Write-Host "`n    $installDir\.venv\Scripts\start_photomap.exe`n" -ForegroundColor Cyan

# 6. Create a batch script to start the slideshow
$batPath = Join-Path $installDir "start_photomap.bat"
$exePath = "$installDir\.venv\Scripts\start_photomap.exe"

$batContent = @"
@echo off
REM This script starts the PhotoMap server
"$exePath"
"@
Set-Content -Path $batPath -Value $batContent -Encoding ASCII

Write-Host "`nA shortcut batch script has been created at:" -ForegroundColor Green
Write-Host "    $batPath" -ForegroundColor Cyan
Write-Host "You can run this script to start the PhotoMap server." -ForegroundColor Yellow
Write-Host "For convenience, you may copy it to a folder in your PATH." -ForegroundColor Yellow


Write-Host "Press any key to continue..."
$x = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")