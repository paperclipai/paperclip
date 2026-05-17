# CrewBrief — React Native App

Flight briefing viewer for iOS (iPhone). Displays METAR/TAF, NOTAMs, route info, and weather alerts from the CrewBrief API. Allows crew feedback submission.

## Quick Start

```bash
# Install dependencies from monorepo root
pnpm install

# Start Expo dev server
cd packages/crewbrief-app
pnpm start
```

Scan the QR code with Expo Go (iPhone) or press `i` to open iOS simulator.

## Building for iPhone (Physical Device)

### Prerequisites

- macOS with **Xcode 16.x** (latest stable)
- An **Apple Developer account** (individual or team, $99/yr)
- A **physical iPhone** running iOS 18+
- USB cable for initial provisioning

### One-time Setup

1. **Install Xcode** from the Mac App Store. Open it once after install to accept licenses and install command-line tools.

2. **Install CocoaPods** (if not already installed):
   ```bash
   sudo gem install cocoapods
   ```

3. **Register your iPhone** in the Apple Developer Portal:
   - Open Xcode → Window → Devices & Simulators
   - Connect your iPhone via USB
   - Select it and check "Show as run destination"
   - If Xcode prompts "Register Device", click **Register**

4. **Create a development provisioning profile** (Xcode handles this automatically for most Apple Developer accounts):
   - In Xcode: Settings → Accounts → Add Apple ID if not added
   - Xcode will auto-manage signing for development builds

### Build & Install

**Option A — Expo Dev Client (recommended for quick iteration):**

```bash
cd packages/crewbrief-app

# Build the iOS app with development client
npx expo run:ios --device
```

This opens a device picker — select your connected iPhone. Xcode will:
- Resolve Swift/Obj-C packages via CocoaPods
- Sign the app with your development certificate
- Build and install the app on your iPhone

**Option B — EAS Build (remote builds, no macOS needed if using cloud):**

```bash
# Install EAS CLI
npm install -g eas-cli

# Log in to Expo account
eas login

# Configure build
eas build:configure

# Build for iOS
eas build --platform ios --profile development

# Install on device (QR code install via Expo Go or .ipa download)
```

### After Installing

1. On your iPhone, go to **Settings → General → VPN & Device Management**
2. Tap your developer certificate and **Trust** it
3. Open the CrewBrief app
4. Set the API URL to your running backend (e.g. `https://api.crewbrief.app`)

For local development, make sure your dev server is accessible from the iPhone (same WiFi network, use your Mac's LAN IP like `http://192.168.1.100:3100`).

## Configuration

### API URL

The app uses `http://localhost:3100` in dev mode by default. On a physical iPhone, change this to your machine's LAN IP or production URL from the Home screen.

### Environment

| Key | Default (Dev) | Production |
|-----|--------------|------------|
| API URL | `http://localhost:3100` | `https://api.crewbrief.app` |

## App Architecture

```
App.tsx                   — Navigation container, stack setup
src/screens/
  HomeScreen.tsx           — Input form: API URL, Trip ID, Duty Day ID
  BriefingScreen.tsx       — Wraps BriefingDetailScreen from react-native-hooks
```

Screens and data-fetching hooks come from `@paperclipai/react-native-hooks`:
- `BriefingDetailScreen` — full briefing view with weather, NOTAMs, route, alerts
- `FeedbackSheet` — modal for submitting rating + category feedback
- `useBriefingDetail` — fetches briefing data from the API
- `useBriefingFeedback` — submits feedback to the API

## Known Limitations

### Current Issues

1. **No authentication** — The app does not authenticate users. API calls are unauthenticated. The backend must allow anonymous access or the app needs auth integration.

2. **Demo trip IDs** — The default trip/duty IDs (`demo-trip-001`/`demo-duty-001`) are placeholders. Real trip data depends on the CrewBrief API state.

3. **No offline support** — The app requires a network connection. No caching or offline fallback.

4. **No push notifications** — CrewBrief does not notify when new briefings are available.

5. **No background fetch** — Briefings are loaded on-demand only.

6. **No pull-to-refresh on error state** — Pull-to-refresh works on the briefing detail screen when data is loaded, but the error/not-found states only offer a "Retry" button.

7. **iOS-only** — This app is configured for iOS. Android build is not tested.

8. **Feedback sheet lacks haptic feedback** — No vibration/impact feedback on submission.

### Rough Edges

- Input validation is minimal on the home screen
- No loading skeleton — full-screen spinner during brief loading
- Fonts are system defaults only (no custom typefaces)
- No dark mode support
- Split-screen/multitasking on iPad not optimized
- The FAB (Feedback button) overlaps long content on smaller iPhones

## Identified Blockers

| Blocker | Impact | Suggested Resolution |
|---------|--------|---------------------|
| Apple Developer account required | Cannot install on device without paid membership | Enroll in Apple Developer Program ($99/yr) |
| Provisioning profiles expire (7 days for free accounts, 1 year for paid) | App stops launching after profile expires | Apple Developer account or EAS Build with auto-re-signing |
| Local dev server not accessible from iPhone on different network | Cannot test against local backend | Use a tunnel (ngrok) or deploy backend to staging |
| CocoaPods may fail with M1/M2 Macs | `pod install` errors | `sudo arch -x86_64 gem install ffi` then retry |
| `expo run:ios` requires a Mac | Windows/Linux users cannot build for iOS | Use EAS Build cloud service |
