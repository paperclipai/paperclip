# neurOS macOS Native Foundation

Date: 2026-04-10

## Goal

Create the native macOS foundation for `neurOS` inside the current Paperclip repository, with SwiftUI as the primary desktop technology and parity-oriented architecture that can evolve toward full product coverage.

## Product Decisions

- `neurOS` is the product name for the evolving Paperclip experience.
- Web and macOS remain first-class surfaces.
- The macOS app must be fully native in SwiftUI.
- V1 targets parity with the current product surface, even when some areas remain technically dense.
- Primary home is the `Central Operacional`.
- The app supports hybrid operation across local and remote instances.
- Teams and agencies on the same local network are a primary use case.
- The primary node exists technically but remains invisible in the UX.
- Failover is manual-assisted in V1.
- Authentication is required per user, with local accounts first and SSO-ready architecture.

## Implementation Shape

The initial foundation is structured under `apps/neuros-macos` as a Swift Package so the repository can host native SwiftUI code immediately, even before a full Xcode-managed distribution setup is introduced.

### Modules

- `NeurOSAppCore`
  - typed desktop models
  - app identity
  - global observable app state
  - runtime mode and connection state

- `NeurOSDesktopServices`
  - native service protocols
  - bootstrap coordinator
  - initial preview/live stubs for:
    - notifications
    - login item
    - local network discovery
    - manual primary-node promotion
    - operations snapshot loading

- `NeurOSDesktopFeatures`
  - SwiftUI navigation shell
  - operational home
  - settings
  - placeholder routing for parity surfaces still to be implemented

- `NeurOSDesktopApp`
  - application entry point
  - scenes
  - menu bar extra

## Why Swift Package First

The current environment has Swift 6.3 available, but no active full Xcode developer directory, so a complete notarizable `.app` bundle cannot be validated from this session. Swift Package keeps the foundation real and compilable while preserving an easy migration path to:

- an Xcode project
- signing and notarization
- app bundle resources
- release automation

## Near-Term Follow-Up

1. Add a generated or checked-in Xcode project for macOS distribution workflows.
2. Stabilize backend contracts for Swift consumption.
3. Replace preview providers with real API clients.
4. Add native authentication and session persistence.
5. Add first-class SwiftUI implementations for:
   - companies
   - issues
   - agents
   - approvals
   - projects/workspaces
   - runtime telemetry
   - plugins
6. Add network topology management and assisted failover UX.

## Risks

- Full parity will require deliberate API-contract work, not only UI work.
- Native SwiftUI delivery increases the amount of product surface maintained in parallel with web.
- App packaging, signing, and notarization are blocked until the repo is moved onto a machine with full Xcode app tooling enabled.
