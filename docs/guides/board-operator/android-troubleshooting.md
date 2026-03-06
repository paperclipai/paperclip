---
title: Android Testing Troubleshooting
summary: Fast fixes for common install, auth, and connectivity issues
---

Use this page during internal Android testing to resolve common blockers quickly.

## Install Problems

| Symptom | Likely Cause | Fix |
| --- | --- | --- |
| `expo` command fails to launch Android | Dependencies not installed | Run `pnpm install` at repo root, then `pnpm --dir mobile android` |
| APK will not install | Install-from-source permission blocked | Enable "Install unknown apps" for the app used to open the APK, then retry |
| "App not installed" error | Corrupted or partial download | Re-download APK from release artifact and install again |

## Sign-In Problems

| Symptom | Likely Cause | Fix |
| --- | --- | --- |
| Error says missing config | Required `EXPO_PUBLIC_*` values not set | Set `EXPO_PUBLIC_PAPERCLIP_COMPANY_ID` and `EXPO_PUBLIC_PAPERCLIP_AGENT_ID`, relaunch app |
| API returns `401 Unauthorized` | Invalid/expired bearer token | Generate a fresh token and paste it into `Bearer token` field |
| API returns `403` | Token is for different company | Use token scoped to the same `companyId` as app config |
| `Load inbox` button is disabled | Token input empty or config missing | Add token and required config values |

## Connectivity Problems

| Symptom | Likely Cause | Fix |
| --- | --- | --- |
| Inbox stays empty with no error | No tasks for configured `assigneeAgentId` in `todo/in_progress/blocked` | Verify assigned tasks exist for that exact agent |
| Inbox shows network error | Device cannot reach Paperclip API | Validate `/api/health` from device network and confirm TLS/certificate validity |
| Works on desktop but not phone | `127.0.0.1`/`localhost` used for API URL | Replace with reachable host (LAN IP, Tailscale, or public URL) |
| API error includes `Unexpected API payload` | Endpoint/proxy returning non-issues payload | Verify app points to Paperclip API server and not docs/UI host only |

## Escalation Bundle (When Filing A Blocker)

Always include:

- App version/build ID
- Device model + Android version
- Environment URL
- Exact failing step
- Screenshot (and logs if available)
