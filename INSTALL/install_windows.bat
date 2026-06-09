@echo off
rem ==========================================================================
rem DEPRECATED: This installer is superseded by the PhotoMapAI desktop
rem installer and will be removed in a future release. Prefer the signed
rem installer (PhotoMapAI-X.X.X-setup.exe) from
rem   https://github.com/lstein/PhotoMapAI/releases
rem or install from PyPI: uv tool install photomapai --torch-backend auto
rem Docs: https://lstein.github.io/PhotoMapAI/installation/
rem ==========================================================================
echo Installing PhotoMapAI (deprecated script)...
powershell -ExecutionPolicy Bypass -File "%~dp0lib\windows.ps1"
