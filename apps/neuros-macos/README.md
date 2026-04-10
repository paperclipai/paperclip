# neurOS macOS

SwiftUI-native macOS foundation for `neurOS`, the Paperclip evolution in this repository.

## Current Scope

- native SwiftUI application shell for macOS
- operational home focused on the `Central Operacional`
- hybrid runtime model ready for local and remote instances
- native service layer prepared for:
  - notifications
  - deep links
  - menu bar
  - login item
  - local network discovery
  - invisible primary-node promotion

## Local Development

```bash
cd apps/neuros-macos
swift build
swift run NeurOSDesktopApp
```

## Architecture

- `NeurOSAppCore`: domain-facing app state and typed desktop models
- `NeurOSDesktopServices`: native service protocols and bootstrap coordinator
- `NeurOSDesktopFeatures`: SwiftUI surfaces and desktop navigation
- `NeurOSDesktopApp`: app entry point and scenes

## Maintainer

- Instagram: `@monrars`
- Site: `goldneuron.io`
- GitHub: `@monrars1995`

## License

This app foundation is covered by the repository MIT license.
