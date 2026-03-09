# ntfy.sh Notifier (Example)

A reference automation plugin that forwards Paperclip events to [ntfy.sh](https://ntfy.sh) or a self-hosted ntfy server.

## Features

- Forwards agent run starts, completions, failures, and cancellations to an ntfy topic.
- Forwards agent status changes.
- Forwards issue creations and comments.
- Forwards approval requests and decisions.
- Supports custom ntfy server URLs.
- Supports access token authentication for protected topics.
- Metric tracking for notifications sent and failures.
- Priority-based notifications and customizable tags.

## Configuration

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `topic` | `string` | **Yes** | The ntfy topic name to publish notifications to. |
| `serverUrl` | `string` | No | Custom ntfy server URL. Defaults to `https://ntfy.sh`. |
| `tokenSecretRef` | `string` | No | Paperclip secret reference containing an access token for protected ntfy topics. |
| `defaultPriority` | `integer` | No | Default priority for notifications (1=min, 5=urgent). Defaults to 3. |
| `defaultTags` | `string[]` | No | Default tags to include in every notification. Defaults to `["paperclip"]`. |
| `eventAllowlist` | `string[]` | No | List of event types that should be forwarded. If empty, all supported events are sent. |

## Supported Events

- `agent.run.started`
- `agent.run.finished`
- `agent.run.failed`
- `agent.run.cancelled`
- `agent.status_changed`
- `issue.created`
- `issue.comment.created`
- `approval.created`
- `approval.decided`

## Example Configuration

```json
{
  "topic": "paperclip-updates",
  "serverUrl": "https://ntfy.sh",
  "defaultPriority": 3,
  "defaultTags": ["paperclip", "dev"],
  "eventAllowlist": ["agent.run.finished", "issue.created"]
}
```

## Setup for Protected Topics

If you use a protected ntfy topic that requires an access token:

1. Create a Paperclip secret named `NTFY_TOKEN` containing your ntfy access token.
2. In the plugin configuration, set `tokenSecretRef` to `NTFY_TOKEN`.
