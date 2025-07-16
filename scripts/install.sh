#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
REPO="dlynch42/cirron-cli"
BINARY_NAME="cirron"
INSTALL_DIR="/usr/local/bin"

# Functions
log() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
    exit 1
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

# Detect OS and architecture
detect_platform() {
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    ARCH=$(uname -m)

    case $ARCH in
        x86_64|amd64) ARCH="x64" ;;
        arm64|aarch64) ARCH="arm64" ;;
        i386|i686) ARCH="x86" ;;
        *) error "Unsupported architecture: $ARCH" ;;
    esac

    case $OS in
        linux) PLATFORM="linux" ;;
        darwin) PLATFORM="macos" ;;
        mingw*|msys*|cygwin*) PLATFORM="win"; BINARY_NAME="cirron.exe" ;;
        *) error "Unsupported OS: $OS" ;;
    esac

    log "Detected platform: $PLATFORM-$ARCH"
}

# Get latest release version
get_latest_version() {
    log "Fetching latest version..."
    
    if command -v curl >/dev/null 2>&1; then
        VERSION=$(curl -s "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)
    elif command -v wget >/dev/null 2>&1; then
        VERSION=$(wget -qO- "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)
    else
        error "curl or wget is required"
    fi

    if [ -z "$VERSION" ]; then
        error "Could not fetch latest version"
    fi

    log "Latest version: $VERSION"
}

# Download and install binary
install_binary() {
    BINARY_FILE="$BINARY_NAME-$PLATFORM-$ARCH"
    if [ "$PLATFORM" = "win" ]; then
        BINARY_FILE="$BINARY_NAME-$PLATFORM-$ARCH.exe"
    fi

    DOWNLOAD_URL="https://github.com/$REPO/releases/download/$VERSION/$BINARY_FILE"
    TEMP_FILE="/tmp/$BINARY_NAME"

    log "Downloading from: $DOWNLOAD_URL"

    if command -v curl >/dev/null 2>&1; then
        curl -L "$DOWNLOAD_URL" -o "$TEMP_FILE" || error "Download failed"
    elif command -v wget >/dev/null 2>&1; then
        wget -O "$TEMP_FILE" "$DOWNLOAD_URL" || error "Download failed"
    else
        error "curl or wget is required"
    fi

    # Make executable
    chmod +x "$TEMP_FILE"

    # Install to system
    log "Installing to $INSTALL_DIR/$BINARY_NAME"
    
    if [ -w "$INSTALL_DIR" ]; then
        mv "$TEMP_FILE" "$INSTALL_DIR/$BINARY_NAME"
    else
        sudo mv "$TEMP_FILE" "$INSTALL_DIR/$BINARY_NAME"
    fi

    success "Cirron CLI installed successfully!"
}

# Verify installation
verify_installation() {
    if command -v cirron >/dev/null 2>&1; then
        VERSION_OUTPUT=$(cirron --version 2>/dev/null || echo "unknown")
        success "Installation verified: $VERSION_OUTPUT"
        echo
        echo "Get started with:"
        echo "  cirron init my-project"
        echo "  cirron build"
        echo "  cirron deploy"
    else
        warn "Installation complete but 'cirron' not found in PATH"
        echo "You may need to restart your terminal or add $INSTALL_DIR to your PATH"
    fi
}

# Check if already installed
check_existing() {
    if command -v cirron >/dev/null 2>&1; then
        CURRENT_VERSION=$(cirron --version 2>/dev/null | grep -o 'v[0-9]\+\.[0-9]\+\.[0-9]\+' || echo "unknown")
        warn "Cirron CLI is already installed ($CURRENT_VERSION)"
        echo -n "Do you want to overwrite it? [y/N] "
        read -r response
        if [[ ! "$response" =~ ^[yY]$ ]]; then
            log "Installation cancelled"
            exit 0
        fi
    fi
}

# Main installation flow
main() {
    echo "Cirron CLI Installer"
    echo "===================="
    echo

    check_existing
    detect_platform
    get_latest_version
    install_binary
    verify_installation
}

# Run main function
main "$@"