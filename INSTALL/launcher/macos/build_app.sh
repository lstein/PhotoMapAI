#!/bin/bash
# Assemble PhotoMapAI.app around the compiled Go launcher.
#
# The bundle's main executable is a tiny wrapper script that opens Terminal and
# runs the real Go binary (kept in Resources/). This is what makes the multi-GB
# first-run install progress visible to the user — a bare Mach-O launched from
# Finder shows no window. The Go binary is a normal Mach-O and gets code-signed
# with the hardened runtime by the caller (see deploy-launcher.yml).
#
# Usage: build_app.sh <go-binary> <version> <output-app-dir> <icns-icon>
set -euo pipefail

BIN="$1"
VERSION="$2"
APP="$3"
ICON="$4"

HERE="$(cd "$(dirname "$0")" && pwd)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# Real launcher binary lives in Resources; sign target for the caller.
cp "$BIN" "$APP/Contents/Resources/photomap"
chmod +x "$APP/Contents/Resources/photomap"

cp "$ICON" "$APP/Contents/Resources/photomap.icns"

sed "s/__VERSION__/${VERSION}/g" "$HERE/Info.plist.template" > "$APP/Contents/Info.plist"

# Wrapper: open Terminal running the real binary so the user sees progress.
cat > "$APP/Contents/MacOS/PhotoMapAI" << 'EOF'
#!/bin/bash
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
osascript \
  -e "tell application \"Terminal\" to do script \"clear; '$RES/photomap'\"" \
  -e 'tell application "Terminal" to activate'
EOF
chmod +x "$APP/Contents/MacOS/PhotoMapAI"

echo "Built $APP"
