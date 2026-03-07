# OpenClaw Adapter Modes

This document describes how `@paperclipai/adapter-openclaw` selects request shape and endpoint behavior.

## Transport Modes

The adapter has two transport modes:

- `sse` (default)
- `webhook`

Configured via `adapterConfig.streamTransport` (or legacy `adapterConfig.transport`).

## Mode Matrix

| streamTransport | configured URL path | behavior |
| --- | --- | --- |
| `sse` | `/v1/responses` | Sends OpenResponses request with `stream: true`, expects `text/event-stream` response until terminal event. |
| `sse` | `/hooks/*` | Rejected (`openclaw_sse_incompatible_endpoint`). Hooks are not stream-capable. |
| `sse` | other endpoint | Sends generic streaming payload (`stream: true`, `text`, `paperclip`) and expects SSE response. |
| `webhook` | `/hooks/wake` | Sends wake payload `{ text, mode }`. |
| `webhook` | `/hooks/agent` | Sends agent payload `{ message, ...hook fields }`. |
| `webhook` | `/v1/responses` | Compatibility flow: tries `/hooks/agent` first, then falls back to original `/v1/responses` if hook endpoint returns `404`. |
| `webhook` | other endpoint | Sends legacy generic webhook payload (`stream: false`, `text`, `paperclip`). |

## Webhook Payload Shapes

### 1) Hook Wake (`/hooks/wake`)

Payload:

```json
{
  "text": "Paperclip wake event ...",
  "mode": "now"
}
```

### 2) Hook Agent (`/hooks/agent`)

Payload:

```json
{
  "message": "Paperclip wake event ...",
  "name": "Optional hook name",
  "agentId": "Optional OpenClaw agent id",
  "wakeMode": "now",
  "deliver": true,
  "channel": "last",
  "to": "Optional channel recipient",
  "model": "Optional model override",
  "thinking": "Optional thinking override",
  "timeoutSeconds": 120
}
```

Notes:

- `message` is always used (not `text`) for `/hooks/agent`.
- `sessionKey` is **not** sent by default for `/hooks/agent`.
- To include derived session keys in `/hooks/agent`, set:
  - `hookIncludeSessionKey: true`

### 3) OpenResponses (`/v1/responses`)

When used directly (SSE mode or webhook fallback), payload uses OpenResponses shape:

```json
{
  "stream": false,
  "model": "openclaw",
  "input": "...",
  "metadata": {
    "paperclip_session_key": "paperclip"
  }
}
```

## Auth Header Behavior

You can provide auth either explicitly or via token headers:

- Explicit auth header:
  - `webhookAuthHeader: "Bearer ..."`
- Token headers (adapter derives `Authorization` automatically when missing):
  - `headers["x-openclaw-token"]` (preferred)
  - `headers["x-openclaw-auth"]` (legacy compatibility)

## Session Key Behavior

Session keys are resolved from:

- `sessionKeyStrategy`: `fixed` (default), `issue`, `run`
- `sessionKey`: used when strategy is `fixed` (default value `paperclip`)

Where session keys are applied:

- `/v1/responses`: sent via `x-openclaw-session-key` header + metadata.
- `/hooks/wake`: not sent as a dedicated field.
- `/hooks/agent`: only sent if `hookIncludeSessionKey=true`.
- Generic webhook fallback: sent as `sessionKey` field.

## Recommended Config Examples

### SSE (streaming endpoint)

```json
{
  "url": "http://127.0.0.1:18789/v1/responses",
  "streamTransport": "sse",
  "method": "POST",
  "headers": {
    "x-openclaw-token": "replace-me"
  }
}
```

### Webhook (hooks endpoint)

```json
{
  "url": "http://127.0.0.1:18789/hooks/agent",
  "streamTransport": "webhook",
  "method": "POST",
  "headers": {
    "x-openclaw-token": "replace-me"
  }
}
```

### Webhook with legacy URL retained

If URL is still `/v1/responses` and `streamTransport=webhook`, the adapter will:

1. try `.../hooks/agent`
2. fallback to original `.../v1/responses` when hook endpoint returns `404`

This lets older OpenClaw setups continue working while migrating to hooks.
