---
title: Android Internal Testing Quickstart
summary: Install the Android build, sign in, and run the core smoke flow
---

Use this guide for internal Android alpha testing of Paperclip Mobile.

## Current Alpha Scope

Only validate flows that are in current MVP scope:

- App opens and renders the shell
- Bearer-token auth input works
- Issue inbox loads and is readable (read-only)

## Prerequisites

- Android device (Android 11+ recommended)
- Paperclip API base URL reachable from your device
- Target `companyId` and `agentId`
- Bearer API key with access to the same company/agent scope
- Either:
  - Source checkout + Expo setup (current reliable path), or
  - Internal APK artifact (when provided for a release)

## 1. Configure Environment

The app reads:

- `EXPO_PUBLIC_PAPERCLIP_API_URL`
- `EXPO_PUBLIC_PAPERCLIP_COMPANY_ID`
- `EXPO_PUBLIC_PAPERCLIP_AGENT_ID`
- optional: `EXPO_PUBLIC_PAPERCLIP_API_KEY` (prefills token input)

Example:

```sh
EXPO_PUBLIC_PAPERCLIP_API_URL=https://paperclip.example.com \
EXPO_PUBLIC_PAPERCLIP_COMPANY_ID=2501a18c-... \
EXPO_PUBLIC_PAPERCLIP_AGENT_ID=457b32e0-... \
pnpm --dir mobile android
```

## 2. Install / Launch On Android

### Option A: Run from source (recommended now)

1. From repo root, install dependencies (`pnpm install`).
2. Start Android target:
   - `pnpm --dir mobile android`
3. Let Expo launch on emulator/device.

### Option B: Install APK artifact (when available)

1. Download APK from internal release artifact.
2. Open APK on Android device.
3. Allow install from source if prompted.
4. Launch `Paperclip Mobile`.

## 3. Authenticate In App

1. On app home, verify config summary does not show missing values.
2. In `Bearer token`, paste a valid Paperclip API key.
3. Tap `Load inbox`.

## 4. Run Core Smoke Flow

1. Open the issue inbox.
2. Confirm the list loads without errors.
3. Confirm entries are sorted by priority then most recently updated.
4. Verify each card shows identifier, title, status, priority, and updated time.
5. Confirm this build is read-only (no issue mutation actions).

## 5. Log Results

Capture these in your test report:

- App version
- Device model + Android version
- Environment URL
- Company ID + Agent ID used
- Pass/fail for each smoke step
- Screenshots for any failure

## Out Of Scope (For This Guide)

- Issue mutation (create/update/checkout/comment)
- Approvals, budgets, or admin workflows
- Anything outside read-only assignee inbox loading
