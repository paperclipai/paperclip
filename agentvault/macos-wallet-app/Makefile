.PHONY: generate build run clean

# Generate Xcode project from project.yml using XcodeGen
generate:
	@echo "Generating Xcode project..."
	@command -v xcodegen >/dev/null 2>&1 || { echo "Installing XcodeGen..."; brew install xcodegen; }
	xcodegen generate
	@echo "Done! Open AgentVaultWallet.xcodeproj in Xcode."

# Build the app (Release)
build: generate
	xcodebuild -project AgentVaultWallet.xcodeproj \
		-scheme AgentVaultWallet \
		-configuration Release \
		-derivedDataPath build \
		build

# Build and run (Debug)
run: generate
	xcodebuild -project AgentVaultWallet.xcodeproj \
		-scheme AgentVaultWallet \
		-configuration Debug \
		-derivedDataPath build \
		build
	@echo "Launching app..."
	open build/Build/Products/Debug/AgentVault\ Wallet.app

# Open in Xcode
open: generate
	open AgentVaultWallet.xcodeproj

# Clean build artifacts
clean:
	rm -rf build
	rm -rf AgentVaultWallet.xcodeproj

# Quick setup: install dependencies and generate project
setup:
	@echo "Checking dependencies..."
	@command -v xcodegen >/dev/null 2>&1 || { echo "Installing XcodeGen via Homebrew..."; brew install xcodegen; }
	@echo "Generating Xcode project..."
	xcodegen generate
	@echo ""
	@echo "Setup complete! Run one of:"
	@echo "  make open   - Open in Xcode"
	@echo "  make build  - Build from command line"
	@echo "  make run    - Build and launch"
