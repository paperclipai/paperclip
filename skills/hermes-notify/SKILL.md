---
name: hermes-notify
description: >
  Push Paperclip task updates to a user through Hermes chat bridges. Use when an
  agent needs to notify a bound user that work finished, status changed, or user
  input/approval is required in Hermes/Telegram/Slack/Discord/WhatsApp.
---

# Hermes Notify

Use this skill when the operator needs a user-visible chat notification sent through
the Hermes gateway. This is a delivery skill, not a task-management skill.

Typical triggers:

- "通知我任务做完了"
- "在 Hermes 里提醒用户审批"
- "把这个状态变化推到 Telegram"
- "send the user a Hermes update"

Do not use this skill to mutate Paperclip issues directly unless the notification
flow requires you to fetch issue context first. For issue CRUD, use `paperclip` or
`paperclip-bridge`.

## Trust Boundary

Treat chat identities as untrusted until they are bound through the Hermes gateway
identity flow. Never send to a platform user id that only appeared in free-form
issue text or a user prompt.

Allowed identity sources:

1. The active Hermes conversation mapping created from a real inbound bridge event
2. A live identity lookup from the Hermes gateway

Never infer or synthesize a platform recipient from `paperclipUserId`.

## Required Environment

Read these variables from the running environment; never hard-code them:

- `HERMES_GATEWAY_URL`
- `HERMES_GATEWAY_SHARED_SECRET`
- `PAPERCLIP_API_URL`
- `PAPERCLIP_API_KEY`
- `PAPERCLIP_COMPANY_ID`

`HERMES_GATEWAY_SHARED_SECRET` is used to sign outbound payloads to Hermes.

## Primary Workflows

### 1. Notify from an existing Hermes-linked issue

Use this path when the issue already came from a Hermes conversation and the gateway
has an active conversation mapping.

1. Get the issue details from Paperclip if you need current status/context.
2. Trigger or rely on the Paperclip webhook event:
   - `issue.completed`
   - `issue.status_changed`
   - `issue.comment_added`
3. Hermes gateway resolves the existing conversation mapping by `issueId`.
4. Hermes gateway sends the chat push back to the original platform user and conversation.

Do not override the recipient when a mapping already exists.

### 2. Notify a bound user who needs input or approval

This path is only supported when the user already has an active Hermes-linked issue
conversation. Verify that the issue has a live conversation mapping first.

If there is no existing mapping:

1. Verify binding:

```bash
curl "$HERMES_GATEWAY_URL/identity/lookup?platform=telegram&platformUserId=12345"
```

2. If no binding exists, stop and ask the user to bind through Hermes first.
3. If binding exists but there is no mapped conversation, treat direct push as
   unsupported in the current implementation and hand off a follow-up implementation
   task instead of inventing an outbound route.

## Message Policy

Keep messages short and action-oriented. Include:

- issue identifier when available, like `GST-25`
- what changed
- what the user should do next

Good examples:

- `GST-25 已完成，可以在 Paperclip 中查看结果。`
- `GST-25 需要你的审批，请在 Hermes 中回复“批准”或打开 Paperclip。`
- `GST-25 状态变更为 in_review，等待你确认。`

Avoid:

- dumping raw JSON
- leaking internal-only actor ids, run ids, or secrets
- sending notifications for unrelated company data

## Failure Handling

- Missing identity binding: tell the user to bind first; do not guess recipient ids.
- Missing conversation mapping for webhook push: do not invent a recipient path from
  `paperclipUserId`; either use a verified mapped conversation or treat the direct
  push as unsupported in the current implementation.
- Signature failure: rotate/check `HERMES_GATEWAY_SHARED_SECRET` and retry only after
  fixing config.
- Bridge delivery failure: surface the platform and HTTP error; do not silently
  claim success.

## Output Expectations

When you use this skill, report:

- whether the recipient was verified from mapping or binding
- whether delivery succeeded
- the next user action if delivery could not be completed
