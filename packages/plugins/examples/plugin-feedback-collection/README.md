# Feedback Collection Plugin (Example)

`@paperclipai/plugin-feedback-collection` normalizes external feedback payloads from Jira, Bitbucket, and Slack into actionable Paperclip issues.

## What It Supports

- Agent tool: `ingest_feedback`
- Webhook endpoints:
  - `/api/plugins/:pluginId/webhooks/jira`
  - `/api/plugins/:pluginId/webhooks/bitbucket`
  - `/api/plugins/:pluginId/webhooks/slack`

Core flow:

1. Receive source payload
2. Normalize title/description/priority
3. Create a Paperclip issue
4. Optionally append raw payload as an issue comment

## Configuration

Set plugin config in Paperclip settings:

- `defaultCompanyId`: fallback company when tool/webhook payload does not include one
- `defaultProjectId`: optional default project placement
- `defaultGoalId`: optional default goal placement
- `defaultParentId`: optional default parent issue
- `appendRawPayloadComment`: append raw payload to a comment on each created issue
- `webhookAuthSecretRef`: optional secret ref for webhook auth token

If `webhookAuthSecretRef` is set, each webhook request must include:

- Header: `x-feedback-token: <resolved secret value>`

## Varlock Credential Workflow

Board request asked for `varlock`-based credential guidance. Recommended pattern:

1. Define a varlock secret for webhook token:
   - Key: `FEEDBACK_WEBHOOK_TOKEN`
2. Configure plugin `webhookAuthSecretRef` to your secret reference.
3. In your webhook relay script/service, load token via varlock and send:
   - `x-feedback-token: $FEEDBACK_WEBHOOK_TOKEN`

This keeps webhook auth credentials out of plaintext configs while letting the plugin enforce ingestion auth.

## Tool Usage Example

```json
{
  "source": "jira",
  "payload": {
    "key": "ENG-42",
    "fields": {
      "summary": "Build fails on Windows",
      "description": "npm install fails with ENOENT",
      "priority": { "name": "High" }
    }
  },
  "labels": ["feedback", "jira"]
}
```

Expected result:

- New Paperclip issue created with normalized title/description/priority
- Tool result includes created issue ID

## Development

```bash
pnpm --filter @paperclipai/plugin-feedback-collection typecheck
pnpm --filter @paperclipai/plugin-feedback-collection test
pnpm --filter @paperclipai/plugin-feedback-collection build
```
