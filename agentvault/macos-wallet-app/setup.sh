#!/bin/bash
set -euo pipefail

echo "==================================="
echo " AgentVault Wallet - macOS Setup"
echo "==================================="
echo ""

# Check for Xcode
if ! command -v xcodebuild &> /dev/null; then
    echo "ERROR: Xcode is not installed."
    echo "Install Xcode from the Mac App Store or run:"
    echo "  xcode-select --install"
    exit 1
fi

echo "[OK] Xcode found: $(xcodebuild -version | head -1)"

# Check for Homebrew
if ! command -v brew &> /dev/null; then
    echo ""
    echo "Homebrew is not installed. Install it? (recommended for XcodeGen)"
    read -p "[y/N] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    else
        echo "Skipping Homebrew. You'll need to install XcodeGen manually."
    fi
fi

# Check/install XcodeGen
if ! command -v xcodegen &> /dev/null; then
    echo ""
    echo "Installing XcodeGen..."
    if command -v brew &> /dev/null; then
        brew install xcodegen
    else
        echo "ERROR: Cannot install XcodeGen without Homebrew."
        echo "Install manually: https://github.com/yonaskolb/XcodeGen"
        exit 1
    fi
fi

echo "[OK] XcodeGen found: $(xcodegen --version)"

# Generate Xcode project
echo ""
echo "Generating Xcode project..."
cd "$(dirname "$0")"
xcodegen generate

echo ""
echo "==================================="
echo " Setup Complete!"
echo "==================================="
echo ""
echo "Next steps:"
echo "  1. Open the project:  open AgentVaultWallet.xcodeproj"
echo "  2. Select your team in Signing & Capabilities"
echo "  3. Build and run (Cmd+R)"
echo ""
echo "Or build from terminal:"
echo "  make build   - Build release"
echo "  make run     - Build and launch debug"
echo ""

# Offer to open in Xcode
read -p "Open in Xcode now? [Y/n] " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Nn]$ ]]; then
    open AgentVaultWallet.xcodeproj
fi
