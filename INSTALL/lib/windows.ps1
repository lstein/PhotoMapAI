#!/usr/bin/pwsh

function Show-ErrorAndExit {
    param (
        [string]$Message
    )
    Write-Host "[ERROR] $Message" -ForegroundColor Red
    Write-Host "Press any key to continue..." -ForegroundColor Yellow
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}

function Install-Python {
    param (
        [string]$ReasonMessage = "Python is not installed."
    )
    $pythonInstallerUrl = "https://www.python.org/ftp/python/3.12.3/python-3.12.3-amd64.exe"
    $pythonInstallerPath = "$env:TEMP\python-installer.exe"

    $response = Read-Host "$ReasonMessage Would you like to download and install Python now? (Y/N) [Y]"
    if ([string]::IsNullOrWhiteSpace($response)) {
        $response = "Y"
    }
    if ($response -notin @('Y', 'y')) {
        Write-Host "Python installation cancelled by user."
        Pause
        exit 1
    }

    Write-Host "Downloading Python installer from $pythonInstallerUrl ..."
    Invoke-WebRequest -Uri $pythonInstallerUrl -OutFile $pythonInstallerPath

    Write-Host "Launching Python installer. Please complete the installation and then re-run this script."
    Write-Host "Be sure to check 'Add Python to PATH' during installation. It is also recommended to disable the path length limit."
    Start-Process $pythonInstallerPath

    Write-Host "When Python installation is complete please close this terminal window and relaunch the PhotoMapAI installer." -ForegroundColor Yellow
    Pause
    exit 0
}

function Install-VisualCPlusPlus {
    param (
        [string]$ReasonMessage = "Missing Microsoft Visual C++ Runtime DLLs."
    )
    $vcUrl = "https://aka.ms/vs/17/release/vc_redist.x64.exe"
    $vcInstallerPath = "$env:TEMP\vc_redist.x64.exe"

    $response = Read-Host "$ReasonMessage Would you like to download and install the Microsoft Visual C++ Redistributable now? (Y/N) [Y]"
    if ([string]::IsNullOrWhiteSpace($response)) {
        $response = "Y"
    }
    if ($response -notin @('Y', 'y')) {
        Write-Host "Visual C++ installation cancelled by user."
        Pause
        exit 1
    }

    Write-Host "Downloading Visual C++ Redistributable installer from $vcUrl ..."
    Invoke-WebRequest -Uri $vcUrl -OutFile $vcInstallerPath

    Write-Host "Launching installer. Please complete the installation and then re-run this script."
    Start-Process $vcInstallerPath

    Write-Host "When installation is complete please close this terminal window and relaunch the PhotoMapAI installer." -ForegroundColor Yellow
    Pause
    exit 0
}

# 1. Check Python version 
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    Install-Python "Python is not installed."
}

$version = python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
if (-not $version) {
    Install-Python "Could not determine Python version."
}
if ([version]$version -lt [version]"3.10" -or [version]$version -ge [version]"3.13") {
    Install-Python "An incompatible Python version is installed."
}

Write-Host "Python version $version detected." -ForegroundColor Green

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

# 3. Check for Microsoft Visual C++ Redistributable DLLs
$requiredDlls = @("msvcp140.dll", "vcruntime140.dll")
$system32 = "$env:windir\System32"
$missingDlls = $requiredDlls | Where-Object { -not (Test-Path (Join-Path $system32 $_)) }

if ($missingDlls.Count -gt 0) {
    $dllList = $missingDlls -join ', '
    Install-VisualCPlusPlus "Missing Microsoft Visual C++ Runtime DLLs: $dllList"
}

Write-Host "The required Visual C++ DLLs are installed." -ForegroundColor Green

# 4. Set default install location to Documents folder
$documentsPath = [Environment]::GetFolderPath('MyDocuments')
$defaultInstallDir = Join-Path $documentsPath "PhotoMap"

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

# 5. Create virtual environment in the installdir
Write-Host "Creating virtual environment in $installDir ..."
python -m venv . --prompt "photomap"

# 6. Activate virtual environment and install PhotoMap
$venvActivate = ".\Scripts\Activate.ps1"
if (-not (Test-Path $venvActivate)) {
    Write-Host "Failed to create virtual environment. Exiting." -ForegroundColor Red
    Pause
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

# 7. install the clip model
Write-Host "Installing the CLIP model..."
python -c "import clip; clip.load('ViT-B/32')"

# 8. Create a batch script to start the server
$desktopPath = [Environment]::GetFolderPath('Desktop')
$batPath = Join-Path $desktopPath "start_photomap.bat"
$exePath = "$installDir\Scripts\start_photomap.exe"

$batContent = @"
@echo off
REM This script starts the PhotoMap server
"$exePath"
pause
"@
Set-Content -Path $batPath -Value $batContent -Encoding ASCII

Write-Host "`nA shortcut batch script has been created at:" -ForegroundColor Green
Write-Host "    $batPath" -ForegroundColor Cyan
Write-Host "You can run this script to start the PhotoMap server." -ForegroundColor Yellow
Write-Host "For convenience, you may copy it to a folder in your PATH." -ForegroundColor Yellow

Pause