#!/usr/bin/pwsh

# 1. Check Python version 
$install_python_message = "Please install Python 3.10, 3.11 or 3.12 from https://www.python.org/downloads/windows"
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    Write-Host "Python is not installed. $install_python_message" -ForegroundColor Red
    exit 1
}

$version = python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
if (-not $version) {
    Write-Host "Python is not installed. $install_python_message" -ForegroundColor Red
    exit 1
}
if ([version]$version -lt [version]"3.10" -or [version]$version -ge [version]"3.13") {
    Write-Host "Python version $version found. $install_python_message" -ForegroundColor Red
    exit 1
}

# 2. Check whether CUDA is installed
$cuda_installed = $false
$cuda_version = $null

if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
    try {
        $nvidia_output = nvidia-smi 2>$null
        if ($nvidia_output) {
            $cuda_installed = $true
            $nvidia_output_str = $nvidia_output -join "`n"
            # Extract CUDA version using regex
            if ($nvidia_output_str -match "CUDA Version:\s+(\d+\.\d+)") {
                $cuda_version = $matches[1]
                Write-Host "CUDA Version $cuda_version detected." -ForegroundColor Green
            }
        }
    }
    catch {
        Write-Host "Could not determine CUDA version: $($_.Exception.Message)." -ForegroundColor Yellow
    }
}

# 2. Set default install location to Documents folder
$envUser = $env:USERNAME
$defaultInstallDir = "$env:USERPROFILE\Documents\PhotoMap"

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

# 3. Create virtual environment in the installdir
Write-Host "Creating virtual environment in $installDir ..."
python -m venv . --prompt "photomap"

# 4. Activate virtual environment and install PhotoMap
$venvActivate = ".\Scripts\Activate.ps1"
if (-not (Test-Path $venvActivate)) {
    Write-Host "Failed to create virtual environment. Exiting." -ForegroundColor Red
    exit 1
}

Write-Host "Activating virtual environment and installing PhotoMap..."
& $venvActivate
python -mpip install --upgrade pip
if ($cuda_installed) {
    Write-Host "CUDA detected. Installing PyTorch with CUDA support..." -ForegroundColor Green
    # Choose PyTorch CUDA version based on detected CUDA version
    $cuda_suffix = ""
    if ([version]$cuda_version -ge [version]"12.4") {
        $cuda_suffix = "cu124"
    } elseif ([version]$cuda_version -ge [version]"12.1") {
        $cuda_suffix = "cu121"
    } elseif ([version]$cuda_version -ge [version]"11.8") {
        $cuda_suffix = "cu118"
    } else {
        Write-Host "CUDA version $cuda_version may not be fully supported. Installing CPU-only PyTorch..." -ForegroundColor Yellow
        $cuda_suffix = ""
    }
    
    if ($cuda_suffix) {
        pip install torch torchvision --index-url https://download.pytorch.org/whl/$cuda_suffix
    } else {
        pip install torch torchvision
    }
} else {
    Write-Host "No CUDA detected. Installing CPU-only PyTorch..." -ForegroundColor Yellow
    pip install torch torchvision
}

# The repo root is two levels up from the installation script
pip install "$PSScriptRoot\..\.."

# 5. Print out instructions for running start_photomap
# $slideshowPath = Resolve-Path .\Scripts\start_slideshow.exe
# Write-Host "`nPhotoMap installed successfully in $installDir!" -ForegroundColor Green
# Write-Host "To start the slideshow, run:" -ForegroundColor Yellow
# Write-Host "`n    $slideshowPath`n" -ForegroundColor Cyan
# Write-Host "Or, if your shell is not activated, run:" -ForegroundColor Yellow
# Write-Host "`n    $installDir\Scripts\start_photomap.exe`n" -ForegroundColor Cyan

# 6. Create a batch script to start the slideshow
$batPath = Join-Path $env:USERPROFILE "Desktop\start_photomap.bat"
$exePath = "$installDir\Scripts\start_photomap.exe"

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