#!/bin/bash
# filepath: /home/lstein/Projects/PhotoMap/INSTALL/install_linux_mac.sh

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
print_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Function to detect OS
detect_os() {
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        echo "linux"
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        echo "mac"
    else
        echo "unknown"
    fi
}

# Function to check Python version
check_python() {
    if ! command -v python3 &> /dev/null; then
        print_error "Python 3 is not installed. Please install Python 3.10 or higher."
        exit 1
    fi
    
    local python_version=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
    local required_version="3.10"
    
    if ! python3 -c "import sys; exit(0 if sys.version_info >= (3, 10) else 1)" 2>/dev/null; then
        print_error "Python ${python_version} detected. PhotoMap requires Python ${required_version} or higher."
        exit 1
    fi
    
    print_info "Python ${python_version} detected (OK)"
}

# Function to create desktop launcher
create_desktop_launcher() {
    local install_path="$1"
    local os_type="$2"
    
    case "$os_type" in
        "linux")
            create_linux_launcher "$install_path"
            ;;
        "mac")
            create_mac_launcher "$install_path"
            ;;
        *)
            print_warn "Desktop launcher creation not supported for this platform"
            ;;
    esac
}

# Function to create Linux desktop launcher
create_linux_launcher() {
    local install_path="$1"
    local desktop_dir="$HOME/Desktop"
    local launcher_file="$desktop_dir/PhotoMapAI.desktop"
    
    # Check if Desktop directory exists
    if [[ ! -d "$desktop_dir" ]]; then
        print_warn "Desktop directory not found. Trying to create launcher in ~/.local/share/applications/"
        desktop_dir="$HOME/.local/share/applications"
        launcher_file="$desktop_dir/PhotoMapAI.desktop"
        mkdir -p "$desktop_dir"
    fi
    
    cat > "$launcher_file" << EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=PhotoMapAI
Comment=AI-based image clustering and exploration tool
Exec=Exec=sh -c '$install_path/bin/start_photomap; echo "Press Enter to exit..."; read'
Icon=image-x-generic
Terminal=true
Categories=Graphics;Photography;
EOF
    
    chmod +x "$launcher_file"
    print_info "Desktop launcher created at: $launcher_file"
}

# Function to create macOS launcher
create_mac_launcher() {
    local install_path="$1"
    local desktop_dir="$HOME/Desktop"
    local app_dir="$desktop_dir/PhotoMap.app"
    
    # Create app bundle structure
    mkdir -p "$app_dir/Contents/MacOS"
    mkdir -p "$app_dir/Contents/Resources"
    
    # Create Info.plist
    cat > "$app_dir/Contents/Info.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>PhotoMap</string>
    <key>CFBundleIdentifier</key>
    <string>com.lincolnstein.photomapai</string>
    <key>CFBundleName</key>
    <string>PhotoMap</string>
    <key>CFBundleVersion</key>
    <string>0.3.0</string>
    <key>CFBundleShortVersionString</key>
    <string>0.3.0</string>
    <key>LSUIElement</key>
    <false/>
</dict>
</plist>
EOF
    
    # Create launcher script that opens Terminal
    cat > "$app_dir/Contents/MacOS/PhotoMap" << EOF
#!/bin/bash
osascript -e "tell application \"Terminal\" to do script \"cd '$install_path' && source bin/activate && start_photomap\""
EOF
    
    chmod +x "$app_dir/Contents/MacOS/PhotoMap"
    print_info "macOS app bundle created at: $app_dir"
}

# Main installation function
main() {
    print_info "PhotoMap Installation Script"
    print_info "============================="
    
    # Step 1: Change to repository root
    cd "$(dirname "$0")/.."
    local repo_root=$(pwd)
    print_info "Repository root: $repo_root"
    
    # Step 2: Check Python version
    print_info "Checking Python installation..."
    check_python
    
    # Detect OS
    local os_type=$(detect_os)
    print_info "Detected OS: $os_type"
    
    # Step 3: Ask for installation directory
    local default_install="$HOME/photomap"
    echo
    read -p "Where would you like to install PhotoMap? [$default_install]: " install_path
    install_path="${install_path:-$default_install}"
    
    # Expand tilde
    install_path="${install_path/#\~/$HOME}"
    
    print_info "Installing PhotoMap to: $install_path"
    
    # Step 4: Create virtual environment
    print_info "Creating virtual environment..."
    if [[ -d "$install_path" ]]; then
        print_warn "Directory $install_path already exists."
        read -p "Do you want to remove it and continue? (y/N): " confirm
        if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
            print_info "Installation cancelled."
            exit 0
        fi
        rm -rf "$install_path"
    fi
    
    python3 -m venv "$install_path" --prompt photomap
    
    # Activate virtual environment
    source "$install_path/bin/activate"
    
    # Upgrade pip
    print_info "Upgrading pip..."
    pip install --upgrade pip
    
    # Step 5: Install PhotoMap
    print_info "Installing PhotoMap..."
    pip install -e .

    # Step 6: Install the CLIP model
    print_info "Downloading CLIP model..."
    python -c "import clip; clip.load('ViT-B/32')"
    
    # Step 7: Create desktop launcher
    print_info "Creating desktop launcher..."
    create_desktop_launcher "$install_path" "$os_type"
    
    print_info ""
    print_info "Installation completed successfully!"
    print_info "To start PhotoMap:"
    print_info "  1. Activate the environment: source $install_path/bin/activate"
    print_info "  2. Run: start_photomap"
    print_info ""
    print_info "Or use the desktop launcher that was created just now."
}

# Error handling
trap 'print_error "Installation failed at line $LINENO"' ERR

# Run main function
main "$@"
print_info "Press Enter to exit..."
read