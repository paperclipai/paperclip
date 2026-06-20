---
title: Instance Settings
summary: Manage Paperclip instance-level settings
---

Configure instance-level options, general preferences, and experimental feature flags.

### Permissions & Validation
- **Read**: Any board organization member can fetch instance settings (`GET /api/instance/settings`).
- **Update**: Modifying settings (including general preferences and experimental flags) requires local implicit board or instance admin privileges. Unauthorized update requests will receive a `403 Forbidden` response. Setting an invalid `defaultEnvironmentId` will return `422 Unprocessable` (unprocessable entity).

## Get Instance Settings

```
GET /api/instance/settings
```

Returns the root settings object containing `defaultEnvironmentId`, general preferences, and experimental flags.

**Response:**

```json
{
  "id": "settings-id",
  "defaultEnvironmentId": "env-uuid",
  "general": {
    "censorUsernameInLogs": false
  },
  "experimental": {
    "enableTaskWatchdogs": true,
    "enableIsolatedWorkspaces": true
  },
  "createdAt": "2026-06-21T00:00:00.000Z",
  "updatedAt": "2026-06-21T00:00:00.000Z"
}
```

## Update Instance Settings

```
PATCH /api/instance/settings
{
  "defaultEnvironmentId": "uuid-here"
}
```

Updates the default environment or other core settings.

## Get General Preferences

```
GET /api/instance/settings/general
```

Returns general preferences (e.g., username censoring).

## Update General Preferences

```
PATCH /api/instance/settings/general
{
  "censorUsernameInLogs": true
}
```

Updates general preferences.

## Get Experimental Flags

```
GET /api/instance/settings/experimental
```

Returns the active experimental feature toggles.

## Update Experimental Flags

```
PATCH /api/instance/settings/experimental
{
  "enableTaskWatchdogs": true,
  "enableIsolatedWorkspaces": true
}
```

Enables or disables experimental control plane and runtime features.

## Experimental Liveness Auto-Recovery Preview

```
POST /api/instance/settings/experimental/issue-graph-liveness-auto-recovery/preview
{
  "lookbackHours": 24
}
```

Previews the list of stuck issues that would be recovered. Requires local implicit board or instance admin privileges.

## Experimental Liveness Auto-Recovery Run

```
POST /api/instance/settings/experimental/issue-graph-liveness-auto-recovery/run
{
  "lookbackHours": 24
}
```

Runs the recovery actions for stuck issues. Requires local implicit board or instance admin privileges.
