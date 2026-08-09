# iOS PWA Web Push device-test runbook

Use this runbook to verify the Phase 1 Paperclip Web Push path on a real iPhone or iPad running iOS/iPadOS 16.4 or later.

## Prerequisites

- Paperclip is served over HTTPS at the operator URL (not an HTTP or private-IP URL).
- `PAPERCLIP_VAPID_PUBLIC_KEY`, `PAPERCLIP_VAPID_PRIVATE_KEY`, and `PAPERCLIP_VAPID_SUBJECT` are configured on the Paperclip server, then the server has been restarted.
- You can sign in as the board operator and create a `request_confirmation` interaction in a test issue.

## Device test

1. Open Paperclip in **Safari** on the device. Use the exact HTTPS URL that will send the notification.
2. Tap **Share** in Safari, choose **Add to Home Screen**, then tap **Add**. iOS permits Web Push only from this installed PWA.
3. Open Paperclip from the new Home Screen icon (not from the existing Safari tab) and sign in if prompted.
4. Go to **Instance settings → Profile → Push Notifications**. Turn on **Enable push notifications** and accept the iOS permission prompt. The card should report that this device is subscribed.
5. From Paperclip, create a test `request_confirmation` interaction that targets the board operator. This is the Phase 1 confirmation event that should fan out a push notification.
6. Lock the device or put Paperclip in the background. Confirm that the notification arrives; tap it and verify it opens/focuses Paperclip at the related issue thread.
7. Return to **Profile → Push Notifications**, turn the setting off, and confirm the device becomes unsubscribed. Repeating the test interaction must not alert that device.

## If the push does not arrive

- Verify the app was launched from the Home Screen and that iOS Settings → Notifications → Paperclip permits notifications.
- Confirm the server has all three VAPID environment values and that the public-key endpoint responds; the browser must never receive the private key.
- Confirm the device is shown under **Subscribed devices** before creating the test interaction.
- Inspect the Paperclip server logs for VAPID delivery errors or a stale subscription (HTTP 404/410 is pruned automatically).
