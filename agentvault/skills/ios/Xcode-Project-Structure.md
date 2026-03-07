# Xcode Project Structure Conventions

**Skill ID:** `xcode-project-structure`
**Version:** 1.0.0
**Quality Gates:** *(none — informational)*

---

## Overview

A consistent Xcode project layout makes onboarding faster, reduces merge
conflicts, and keeps CI/CD pipelines predictable. This skill defines the
standard structure for iOS apps built on AgentVault.

---

## Recommended Directory Layout

```
MyApp/
├── MyApp.xcodeproj/               # Xcode project file (checked in)
│   └── project.pbxproj
├── MyApp/                         # Main app target source
│   ├── App/
│   │   ├── MyAppApp.swift         # @main entry point
│   │   └── AppDelegate.swift      # UIApplicationDelegate (if needed)
│   ├── Features/                  # One sub-folder per feature slice
│   │   ├── Feed/
│   │   │   ├── FeedView.swift
│   │   │   ├── FeedViewModel.swift
│   │   │   └── FeedCell.swift
│   │   └── Player/
│   │       ├── PlayerView.swift
│   │       ├── PlayerViewModel.swift
│   │       └── AVPlayerPool.swift
│   ├── Core/                      # Shared utilities, extensions, services
│   │   ├── Extensions/
│   │   ├── Services/
│   │   └── Networking/
│   ├── Models/                    # Value-type domain models
│   ├── Resources/                 # Assets.xcassets, fonts, localizations
│   │   ├── Assets.xcassets
│   │   └── Localizable.strings
│   ├── Supporting Files/
│   │   ├── Info.plist
│   │   └── PrivacyInfo.xcprivacy  # Required since iOS 17
│   └── Preview Content/           # SwiftUI previews; excluded from release build
│       └── Preview Assets.xcassets
├── MyAppTests/                    # Unit test target
│   └── ...
├── MyAppUITests/                  # UI test target
│   └── ...
├── Packages/                      # Local Swift Packages (SPM)
│   └── DesignSystem/
│       ├── Package.swift
│       └── Sources/
└── scripts/                       # Build, lint, code-gen scripts
    ├── swiftlint.sh
    └── generate-strings.sh
```

---

## Rules

### 1. One target per deliverable

| Target type | When to use |
|------------|-------------|
| App | The shipping app binary |
| Framework / Swift Package | Shared code consumed by multiple targets |
| Unit Test | Logic that does not require a simulator |
| UI Test | User-facing flows; run on simulator / device |
| App Extension | Share, Widget, Notification Service, etc. |

Avoid using a single monolithic target that compiles test helpers into the
production binary.

### 2. Use Swift Package Manager for dependencies

Prefer SPM over CocoaPods/Carthage.

```swift
// Package.swift (local package or dependency)
dependencies: [
    .package(url: "https://github.com/pointfreeco/swift-composable-architecture", from: "1.0.0"),
],
targets: [
    .target(name: "MyApp", dependencies: [
        .product(name: "ComposableArchitecture", package: "swift-composable-architecture"),
    ]),
]
```

Commit `Package.resolved` to lock dependency versions across the team.

### 3. Configuration files over Build Settings UI

Store per-environment values in `.xcconfig` files, not in the Xcode Build
Settings editor. This keeps them readable in code review.

```
// Debug.xcconfig
SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG
API_BASE_URL = https://dev-api.example.com

// Release.xcconfig
API_BASE_URL = https://api.example.com
```

Reference in `Info.plist`:

```xml
<key>APIBaseURL</key>
<string>$(API_BASE_URL)</string>
```

### 4. Schemes: Debug / Staging / Release

Maintain three schemes:

| Scheme | Config | Bundle ID Suffix | Description |
|--------|--------|-----------------|-------------|
| `MyApp (Debug)` | Debug | `.debug` | Local dev, all logs, no crash reporter |
| `MyApp (Staging)` | Staging | `.staging` | Internal QA, TestFlight distribution |
| `MyApp (Release)` | Release | *(none)* | App Store / Production |

Mark Staging and Release schemes as **Shared** so CI can select them without
the developer's local xcuserdata.

### 5. Asset catalogs

- One `Assets.xcassets` for app icons, launch images, and colours.
- Separate `Assets.xcassets` inside each Feature folder for feature-specific
  images (keeps the catalogue small, avoids name collisions).
- Use **named colours** in the catalogue; never hard-code `UIColor(red:green:blue:)`.

### 6. Localisation

- Use `String(localized:)` (Swift 5.5+) instead of `NSLocalizedString`.
- Keep one `Localizable.strings` per language in `Resources/`.
- Run `genstrings` or Xcode's extraction in CI to detect missing keys.

### 7. PrivacyInfo.xcprivacy placement

Add to **every** target that links into the final binary (app target, app
extensions, local frameworks). Xcode merges them at archive time.

### 8. Build Phases order

Standard order for reproducible builds:

1. Dependencies
2. Compile Sources
3. Link Binary With Libraries
4. Copy Bundle Resources
5. Run Script – SwiftLint (warning-only in Debug, error in Release)
6. Run Script – Code signing verification

### 9. Minimum Deployment Target

Set a single minimum deployment target at the project level; override only in
specific targets that genuinely support a wider range (e.g. a framework).

Keep the target ≥ iOS 16 unless there is a specific business requirement for
older devices. iOS 17+ is recommended for new features to use `PrivacyInfo.xcprivacy`.

---

## CI/CD Notes

```bash
# Build for testing
xcodebuild \
  -scheme "MyApp (Staging)" \
  -destination "platform=iOS Simulator,name=iPhone 15 Pro,OS=latest" \
  -resultBundlePath TestResults.xcresult \
  test

# Archive for distribution
xcodebuild \
  -scheme "MyApp (Release)" \
  -archivePath MyApp.xcarchive \
  archive

# Export IPA
xcodebuild \
  -exportArchive \
  -archivePath MyApp.xcarchive \
  -exportOptionsPlist ExportOptions.plist \
  -exportPath ./ipa
```

---

## References

- [Apple – Structuring Your App's Code](https://developer.apple.com/documentation/xcode/structuring-your-app-s-code)
- [Apple – Swift Packages](https://developer.apple.com/documentation/xcode/swift-packages)
- [Apple – Customizing the build schemes](https://developer.apple.com/documentation/xcode/customizing-the-build-schemes-for-a-project)
- [WWDC 2023 – Meet Swift Package plugins](https://developer.apple.com/videos/play/wwdc2023/10166/)
