# Paperclip Android dashboard

A native Android (Kotlin, Jetpack Compose) client for the Paperclip board. It
talks to the same `/api` routes as the web UI.

## Screens

- Bottom tabs: Dashboard, Inbox, Tasks, Agents, Approvals.
- Side menu: Search, Decisions, Projects, Routines, Artifacts, Goals,
  Workspaces, Org chart, Skills, Connectors, Members, Costs, Activity, Settings,
  plus the company switcher and project and agent shortcuts.

## Build

Requirements: JDK 17 or later and the Android SDK (compileSdk 36). Put the SDK
path in `android/local.properties` (`sdk.dir=...`) or set `ANDROID_HOME`.

```sh
cd android
./gradlew assembleDebug testDebugUnitTest
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## Connect the app to a Paperclip server

Pair with a QR code (recommended):

1. In the web UI, open **Profile settings → Mobile app** and click **Pair a phone**.
   This creates a board API key named `Mobile app (<date>)` that expires in 90 days.
2. Check the server URL under the code. The phone must be able to reach it.
   If the server has a Tailscale address (`100.64.0.0/10`), the URL uses it by default.
3. In the app, tap **Scan QR code**. You can also scan the code with the phone
   camera: the code is a `paperclip://connect?url=...&key=...` link.

Revoke a phone under **Paired devices** in the same panel.

The sign-in screen also accepts an email and password, a board API key, or
local trusted mode (no auth). With a cookie session, the app sends an `Origin`
header on mutations to satisfy the board mutation guard.

Full setup guide, including remote access when the phone is not on the same network: [`docs/deploy/android-app.md`](../docs/deploy/android-app.md).
