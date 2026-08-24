---
title: Board Chat
summary: Conference Room chat API — stream a board-level conversation response
version: v0.4.0
last_updated: 2026-08-17
---

The Board Chat (Conference Room) endpoint lets operators converse with a board-level assistant that can manage Paperclip objects — issues, plans, approvals, knowledge articles, and memory records — through natural language.

## Feature Gate

The Board Chat is gated behind two layers:

1. **Instance setting**: `enableConferenceRoomChat` must be `true` in instance settings (default: `true`). When disabled, the endpoint returns `403 FEATURE_DISABLED`.
2. **Deployment mode**: Only available in `local_trusted` deployments. Other deployment modes return `403 DEPLOYMENT_MODE_UNSUPPORTED`.

## Stream a Chat Response

```
POST /api/board/chat/stream
```

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `companyId` | `string` | yes | The company to scope the conversation in |
| `message` | `string` | yes | The user's message to the board assistant |
| `taskId` | `string` | no | A specific issue ID to anchor the conversation (if omitted, a standing "Board Operations" issue is found or created) |

### Response

Returns a **Server-Sent Events (SSE)** stream with the following event types:

| Event Type | `data` shape | Description |
|---|---|---|
| `start` | `{ type: "start", issueId: string }` | Emitted immediately to confirm the conversation issue ID |
| `chunk` | `{ type: "chunk", text: string }` | Token-by-token text delta from the assistant's response |
| `status` | `{ type: "status", text: string }` | Status indicator when the assistant is running a tool (e.g., "Running a command...") |
| `action` | `{ type: "action", ... }` | Emitted when the assistant creates or updates a Paperclip object (see [Resolution Cards](/docs/support/assessments/support-case-v0.4.0-chat-to-work-resolution)) |
| `done` | `{ type: "done" }` | Emitted when the response is complete |
| `error` | `{ type: "error", error: string }` | Emitted if the assistant fails to generate a response |

### Error Codes

| Code | HTTP Status | Meaning |
|---|---|---|
| `FEATURE_DISABLED` | 403 | `enableConferenceRoomChat` is not enabled in instance settings |
| `DEPLOYMENT_MODE_UNSUPPORTED` | 403 | Not a `local_trusted` deployment |
| — | 400 | Missing `companyId` or `message` |
| — | 401 | Unauthenticated (missing or invalid API key) |
| `BOARD_CHAT_BUSY` | 429 | Too many concurrent board chats (max 3) |

### Authentication

- **Board users** (via session cookie) — standard board UI flow
- **Agent API keys** — allowed for company-scoped agents

### Example

```sh
curl -sS --fail-with-body -X POST http://localhost:3100/api/board/chat/stream \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"companyId": "$PAPERCLIP_COMPANY_ID", "message": "Create a task to research competitors"}'
```

The response streams SSE events:

```
data: {"type":"start","issueId":"abc-123"}

data: {"type":"chunk","text":"I'll create a task for that."}

data: {"type":"status","text":"Running a command..."}

data: {"type":"action","type":"issue","action":"create","data":{"title":"Research Competitors","url":"http://..."}}

data: {"type":"done"}

```

## Notes

- The assistant runs a local `claude` subprocess with the Paperclip board skill. Max 3 concurrent chats.
- 120-second timeout per request — the subprocess is killed if it exceeds this.
- Conversation history is persisted as comments on the "Board Operations" issue (or specified `taskId`).
- When the assistant creates or updates work objects, the response includes structured `action` events that render as [resolution cards](/docs/support/assessments/support-case-v0.4.0-chat-to-work-resolution) in the Board Chat UI.
- The raw `%%ACTIONS%%` markup that drives action events is stripped from the persisted comment — only the cards remain visible to users.