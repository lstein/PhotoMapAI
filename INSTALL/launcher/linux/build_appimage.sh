#!/bin/bash
# Package the compiled Go launcher as a single-file AppImage.
#
# Usage: build_appimage.sh <go-binary> <version> <output.AppImage> <png-icon>
#
# Requires appimagetool on PATH (CI installs it). The AppImage is a portable
# executable that runs across distros; the launcher then fetches Python + the
# app via uv on first run.
set -euo pipefail

BIN="$1"
VERSION="$2"
OUT="$3"
ICON="$4"

HERE="$(cd "$(dirname "$0")" && pwd)"
APPDIR="$(mktemp -d)/PhotoMapAI.AppDir"

mkdir -p "$APPDIR"
cp "$BIN" "$APPDIR/photomap"
chmod +x "$APPDIR/photomap"
cp "$HERE/photomap.desktop" "$APPDIR/photomap.desktop"
cp "$ICON" "$APPDIR/photomap.png"

# AppRun is the AppImage entry point.
cat > "$APPDIR/AppRun" << 'EOF'
#!/bin/bash
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/photomap" "$@"
EOF
chmod +x "$APPDIR/AppRun"

ARCH="${ARCH:-x86_64}" appimagetool "$APPDIR" "$OUT"
echo "Built $OUT"
