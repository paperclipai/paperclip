# CrewBrief Apple/TestFlight Readiness Checklist

**Issue:** CRE-630  
**Author:** Hunter (CTO)  
**Date:** 2026-05-17  
**Status:** Checklist (no submissions)

---

## Phase 1 — Apple Developer Account & Team Setup

- [ ] **1.1** Verify Apple Developer Program membership is active (individual or organization, $99/yr)
- [ ] **1.2** Confirm Team Agent role is assigned to the correct individual
- [ ] **1.3** Add all required team members (Admin, App Manager, Developer, Marketing) in App Store Connect
- [ ] **1.4** Accept latest Apple Developer Agreement in App Store Connect
- [ ] **1.5** Verify paid agreements are current (no lapsed membership)
- [ ] **1.6** Configure Two-Factor Authentication (2FA) for all Apple IDs with developer access

---

## Phase 2 — Code Signing & Certificates

- [ ] **2.1** Revoke any stale/expired distribution certificates in Apple Developer Portal
- [ ] **2.2** Generate new iOS Distribution certificate (Apple Distribution or Apple Distribution: P3)
- [ ] **2.3** Generate iOS Development certificate (for local device testing)
- [ ] **2.4** Create App Store Connect authentication API key (`.p8` file) for CI/CD (Fastlane match)
- [ ] **2.5** Configure Fastlane match with encrypted Git storage for code signing identities
- [ ] **2.6** Run `fastlane match development` — download development signing assets
- [ ] **2.7** Run `fastlane match appstore` — download distribution signing assets
- [ ] **2.8** Set `DEVELOPMENT_TEAM` in `ios/CrewBrief.xcodeproj/project.pbxproj` to the correct Team ID
- [ ] **2.9** Set `PROVISIONING_PROFILE_SPECIFIER` in project build settings for both Debug and Release
- [ ] **2.10** Verify code signing works: `xcodebuild -workspace CrewBrief.xcworkspace -scheme CrewBrief -configuration Release -destination 'generic/platform=iOS' -archivePath /tmp/CrewBrief archive`

---

## Phase 3 — App Store Connect Record

- [ ] **3.1** Create new iOS app record in App Store Connect with exact bundle ID `com.crewbrief.app`
- [ ] **3.2** Set primary language (English)
- [ ] **3.3** Set SKU (e.g. `CREWBRIEF_IOS_001`)
- [ ] **3.4** Upload first build via Xcode Archive or Transporter (can be placeholder build 1)
- [ ] **3.5** Confirm bundle ID `com.crewbrief.app` is registered in Developer Portal and does not conflict with any other app

---

## Phase 4 — App Metadata & Store Listing

- [ ] **4.1** **App Name** — 30-character max, no "CrewBrief" issues (e.g. "CrewBrief: Flight Briefings")
- [ ] **4.2** **Subtitle** — 30-character max (e.g. "AI-Powered Flight Briefings")
- [ ] **4.3** **Privacy Policy URL** — Host a privacy policy at a public URL (e.g. `https://crewbrief.app/privacy`)
  - [ ] Legal review of privacy policy content (GDPR, CCPA, data retention, encryption disclosure)
- [ ] **4.4** **Support URL** — e.g. `https://crewbrief.app/support`
- [ ] **4.5** **Marketing URL** — optional, e.g. `https://crewbrief.app`
- [ ] **4.6** **Description** — 4000-character max, clearly describe what CrewBrief does (AI-generated flight briefings)
- [ ] **4.7** **Keywords** — 100-character comma-separated list (e.g. "aviation, flight, briefing, pilot, weather, NOTAM, crew")
- [ ] **4.8** **Category** — Primary: Utilities or Reference (choose one); Secondary: optional
- [ ] **4.9** **Content Rights** — Confirm all content is owned or licensed
- [ ] **4.10** **Age Rating** — Complete the App Store age rating questionnaire (likely 4+)
- [ ] **4.11** **Routing App Coverage File** — Optional; only needed if providing routing functionality
- [ ] **4.12** **App Clip** — No, or configure separately if planned

---

## Phase 5 — Build Configuration & Versioning

- [ ] **5.1** Set **iOS Deployment Target** consistently (fix mismatch: Info.plist says `12.0` vs Podfile says `15.1` — standardize on `15.1` or the minimum you will support)
- [ ] **5.2** Update **`CFBundleShortVersionString`** in Info.plist to match `app.json` (e.g. `0.1.0`)
- [ ] **5.3** Update **`CFBundleVersion`** (build number) — increment per submission
- [ ] **5.4** Ensure **`app.json` `expo.version`** matches Info.plist version
- [ ] **5.5** Ensure **`app.json` `expo.ios.buildNumber`** matches Info.plist build
- [ ] **5.6** Set **`app.json` `expo.ios.bundleIdentifier`** to `com.crewbrief.app`
- [ ] **5.7** Configure **`app.json` `expo.ios.supportsTablet`** — decide whether iPad is supported (recommended: `true` for enterprise aviation)
- [ ] **5.8** Verify **`app.json` `expo.ios.infoPlist`** does not override critical values
- [ ] **5.9** Remove or disable **EXUpdates** in production (already disabled in Expo.plist, confirm)

---

## Phase 6 — Icons, Screenshots & Media

- [ ] **6.1** Verify all required icon sizes are present in `ios/CrewBrief/Images.xcassets/AppIcon.appiconset/Contents.json`:
  - [ ] 1024x1024 (App Store)
  - [ ] 20pt@2x, 20pt@3x (Notification)
  - [ ] 29pt@2x, 29pt@3x (Settings)
  - [ ] 40pt@2x, 40pt@3x (Spotlight)
  - [ ] 60pt@2x, 60pt@3x (iPhone)
  - [ ] 76pt@1x, 76pt@2x (iPad)
  - [ ] 83.5pt@2x (iPad Pro)
- [ ] **6.2** Ensure `assets/adaptive-icon.png` in Expo project is correct for Android (not relevant for iOS but keep consistent)
- [ ] **6.3** Take **6.5-inch iPhone screenshots** (iPhone 14 Pro Max or similar, 1290x2796):
  - [ ] Home screen (API URL / Trip ID input)
  - [ ] Briefing view (Overview section)
  - [ ] Briefing view (Weather section)
  - [ ] Briefing view (NOTAMs/Route section)
  - [ ] Dashboard/Feedback screen
- [ ] **6.4** Take **5.5-inch iPhone screenshots** (iPhone 8 Plus, 1242x2208) — same screens as 6.5"
- [ ] **6.5** Optionally take **iPad Pro screenshots** (12.9", 2048x2732) — required if `supportsTablet: true`
- [ ] **6.6** Optionally take **iPad Pro screenshots** (12.9", 2048x2732) for landscape
- [ ] **6.7** Upload all screenshots to App Store Connect via Xcode or Fastlane deliver
- [ ] **6.8** Create **App Preview video** (15-30 seconds, recommended but optional for initial release)

---

## Phase 7 — Privacy & Legal

- [ ] **7.1** **Privacy Nutrition Labels** — Complete in App Store Connect:
  - [ ] Disclose what data the app collects (API URL input, trip IDs, duty day IDs, feedback)
  - [ ] Confirm data is not linked to user identity (currently anonymous)
  - [ ] Disclose any third-party SDK data collection (if any)
- [ ] **7.2** **Privacy Manifest** (`PrivacyInfo.xcprivacy`) — Create file in Xcode project:
  - [ ] Declare required reason APIs if used (NSFileSystem, UserDefaults, etc.)
  - [ ] Add to `ios/CrewBrief/` and include in target
- [ ] **7.3** **Export Compliance** — Determine if CrewBrief uses encryption:
  - [ ] App uses HTTPS (TLS) — standard, exempt from export compliance
  - [ ] App does not implement custom encryption — answer NO to export compliance questions
  - [ ] Document export compliance decision in App Store Connect
- [ ] **7.4** **Data deletion policy** — Document how users can request data deletion
- [ ] **7.5** **Terms of Service** — Host at public URL (e.g. `https://crewbrief.app/terms`)

---

## Phase 8 — TestFlight Configuration

- [ ] **8.1** Archive and upload first build to App Store Connect via:
  - [ ] Xcode Archive → Distribute App → App Store Connect
  - [ ] Or Fastlane: `fastlane build_and_upload`
- [ ] **8.2** Wait for build processing to complete in App Store Connect (~10-30 min)
- [ ] **8.3** Enable TestFlight in App Store Connect (Compose → TestFlight → Enable)
- [ ] **8.4** Configure **Test Information**:
  - [ ] Beta App Description
  - [ ] Feedback Email
  - [ ] Privacy Policy URL
  - [ ] Marketing URL (optional)
- [ ] **8.5** Add **Internal Testers** (up to 100, must be in App Store Connect team):
  - [ ] Jeff (CEO)
  - [ ] Hunter (CTO)
  - [ ] QA engineers
- [ ] **8.6** Add **External Testers** (up to 10,000, requires Beta App Review):
  - [ ] Pilot beta test group (invite via email)
  - [ ] Submit for Beta App Review (takes 1-2 days, similar to full review)
- [ ] **8.7** Send invitation emails to all testers
- [ ] **8.8** Verify testers can install and launch the app via TestFlight
- [ ] **8.9** Add TestFlight feedback channel to company Slack/Teams (or create a dedicated issue label)

---

## Phase 9 — App Capabilities & Entitlements

- [ ] **9.1** Review `ios/CrewBrief/CrewBrief.entitlements` — currently empty:
  - [ ] Add `com.apple.developer.networking.wifi-info` if needed for enterprise networking
  - [ ] Add **Push Notifications** entitlement if push is planned (requires APNs setup)
  - [ ] Add **Associated Domains** if universal links are planned (e.g. `applinks:crewbrief.app`)
- [ ] **9.2** Enable required capabilities in Xcode project:
  - [ ] Push Notifications (if used)
  - [ ] Background Modes (if needed for background fetch)
- [ ] **9.3** Verify no unnecessary capabilities are enabled (reduces review friction)

---

## Phase 10 — Fastlane Automation

- [ ] **10.1** Install Fastlane if not already: `gem install fastlane`
- [ ] **10.2** Initialize Fastlane in `packages/crewbrief-app/ios/`: `fastlane init`
- [ ] **10.3** Create `Fastfile` with lanes:
  - [ ] `build` — build archive
  - [ ] `upload_to_testflight` — upload and distribute to TestFlight
  - [ ] `deploy_to_app_store` — submit for App Store review
  - [ ] `screenshots` — optionally auto-capture using snapshot
- [ ] **10.4** Create `Appfile` with:
  - [ ] `app_identifier "com.crewbrief.app"`
  - [ ] `apple_id "your-apple-id@example.com"`
  - [ ] `team_id "YOUR_TEAM_ID"`
- [ ] **10.5** Create `Matchfile` for code signing via Fastlane match
- [ ] **10.6** Test Fastlane build locally: `fastlane build`
- [ ] **10.7** Test Fastlane TestFlight upload: `fastlane upload_to_testflight`

---

## Phase 11 — CI/CD Integration

- [ ] **11.1** Create GitHub Actions workflow `.github/workflows/crewbrief-testflight.yml`:
  - [ ] Triggers: push to `master` (or a `release/crewbrief-*` branch)
  - [ ] Steps: install dependencies → lint → test → build (expo) → archive → upload to TestFlight
- [ ] **11.2** Store Apple API key (`.p8`) as GitHub secret
- [ ] **11.3** Store Fastlane match passphrase as GitHub secret
- [ ] **11.4** Store App Store Connect app-specific password as GitHub secret
- [ ] **11.5** Test CI/CD pipeline end-to-end with a real build

---

## Phase 12 — Crash Reporting & Monitoring

- [ ] **12.1** Integrate crash reporting SDK:
  - [ ] **Sentry** — recommended for Expo/RN: `npx sentry-wizard -i reactNative`
  - [ ] Or **BugSnag** — alternative option
- [ ] **12.2** Configure source maps upload for symbolication
- [ ] **12.3** Set up crash alerting (Slack/email)
- [ ] **12.4** Configure **performance monitoring** for API call latency tracking
- [ ] **12.5** Verify crashes appear in Sentry/BugSnag dashboard after a test crash

---

## Phase 13 — App Review Preparation

- [ ] **13.1** Create **App Review Notes** in App Store Connect:
  - [ ] Demo account credentials (or explain how to use — app needs API URL + Trip ID + Duty Day ID)
  - [ ] Provide a working demo API URL (`https://api.crewbrief.app`) or a staging API with test data
  - [ ] Explain the app's core functionality (aviation briefings)
- [ ] **13.2** Verify **no placeholder text**, **no broken UI**, **no debug logs** in release build
- [ ] **13.3** Verify **no hardcoded API keys or secrets** in the binary
- [ ] **13.4** Disable **developer menus** (shake gesture, RCTDevMenu) in release builds
- [ ] **13.5** Ensure **all API endpoints used by the app are operational** during review
- [ ] **13.6** Prepare **sign-in instructions** for Apple reviewer (if auth is added before submission)
- [ ] **13.7** Review **App Store Review Guidelines** specifically:
  - [ ] Section 2.1 — App completeness
  - [ ] Section 2.3 — Accurate metadata
  - [ ] Section 2.5 — Software requirements (use public APIs, no private frameworks)
  - [ ] Section 3.1 — Payments (CrewBrief is free/paid? Currently no IAP)
  - [ ] Section 4 — Design (minimum functionality, bug-free)
  - [ ] Section 5.1 — Data collection and privacy

---

## Phase 14 — Submission & Distribution

- [ ] **14.1** Verify **build passes Xcode validation** (Product → Archive → Validate App)
- [ ] **14.2** Select build in App Store Connect → set as "Ready for Submission"
- [ ] **14.3** Complete **export compliance** questionnaire (standard HTTPS encryption = NO for encryption)
- [ ] **14.4** Complete **content rights** declaration
- [ ] **14.5** Set **pricing**:
  - [ ] Free (if no IAP)
  - [ ] Set availability in all desired territories (App Store countries/regions)
- [ ] **14.6** Submit for App Store Review
- [ ] **14.7** Monitor review status (typically 1-3 days, can request expedited review)
- [ ] **14.8** Upon approval — **Release manually** or set for **automatic release**
- [ ] **14.9** Verify production build downloads and functions correctly from App Store
- [ ] **14.10** Monitor crash reports for the first 48 hours post-release

---

## Phase 15 — Post-Launch

- [ ] **15.1** Set up **App Store Connect alerts** (crashes, rejections, reviews, sales)
- [ ] **15.2** Create process for responding to user reviews
- [ ] **15.3** Set up **monthly version cadence** (e.g. every 2-4 weeks)
- [ ] **15.4** Document **release checklist** in the repo for repeatable submissions
- [ ] **15.5** Configure **App Store Connect API key expiry monitoring** (keys expire/need rotation)
- [ ] **15.6** Set up **distribution certificate expiry monitoring** (1-year validity)
- [ ] **15.7** Plan for **iOS version support lifecycle** (drop old iOS versions annually)

---

## Pre-Submission Acceptance Test

Before the first TestFlight upload, verify all of the following:

- [ ] App launches on physical iOS device (iPhone 12+)
- [ ] App accepts API URL input and navigates to briefing
- [ ] Briefing content renders correctly (Overview, Weather, NOTAMs, Route, Alerts)
- [ ] Scrolling works smoothly
- [ ] Feedback FAB opens feedback sheet
- [ ] Feedback submission succeeds
- [ ] Dashboard renders feedback trends
- [ ] App handles network errors gracefully (no crashes, user-friendly error messages)
- [ ] App handles empty/null briefing data without crashing
- [ ] App handles portrait orientation correctly (portrait-locked in app.json — confirm intended)
- [ ] No debug/console logs in release build
- [ ] App icon displays correctly on the home screen
- [ ] Splash screen displays then transitions to home screen

---

## Summary of Gaps (Current State)

| Area | Status | Criticality |
|------|--------|-------------|
| Code on `master` | ❌ All code on `fix/cre-536-briefing-timeout` branch | **BLOCKER** |
| Apple Developer membership | Unknown | **BLOCKER** |
| Distribution certificate | Missing | **BLOCKER** |
| Code signing team (DEVELOPMENT_TEAM) | Missing from pbxproj | **BLOCKER** |
| Fastlane | Not configured | Required |
| Screenshots | Not taken | Required |
| Privacy manifest | Missing | **Required (May 2025 deadline)** |
| Privacy policy URL | Not hosted | Required |
| Crash reporting | Not integrated | Recommended |
| TestFlight testers | Not invited | Required |
| CI/CD pipeline | Not created | Recommended |
| iOS Deployment Target | Mismatch (12.0 vs 15.1) | Fix before submission |

---

**Next step:** All of Phase 1 (Apple Developer account) is the prerequisite. Without an active membership and distribution certificate, no subsequent step can proceed. Coordinate with Jeff to confirm Apple Developer Program status and team membership.
