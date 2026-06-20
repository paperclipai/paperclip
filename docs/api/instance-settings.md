---
title: Instance Settings
summary: Manage Paperclip instance-level settings
---

Configure instance-level options, general preferences, and experimental feature flags.

## Get Instance Settings

```
GET /api/instance/settings
```

Returns the root settings object containing general preferences, company configurations, and experimental flags.

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
