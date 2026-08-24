# Support Case Assessment: v0.4.0 Board Chat (Conference Room) — Workstream C

**Feature**: Board Chat / Conference Room — streaming conversational interface for running a company, backed by `POST /board/chat/stream`
**Assessed by**: Support Engineer (88b72065)
**Date**: 2026-08-17
**Related**: BOARD-1, VOY-1188, VOY-1210, VOY-1263
**Release**: v0.4.0-alpha (shipped 2026-08-17)
**API Reference**: [Board Chat API](/docs/api/chat)

## Feature Overview (User Perspective)

The Board Chat (Conference Room, `/board-chat`) is a conversational interface where operators talk to a board-level assistant that can manage Paperclip objects — issues, plans, approvals, knowledge articles, and memory records. The user types a message ("Create a task to research competitors") and the assistant calls the Paperclip API on their behalf, streaming its response token-by-token.

Key user-facing behaviors:

1. **Conversational company operations** — create/update issues, plans, approvals, knowledge, memory, and decisions by asking in natural language.
2. **Streaming responses** — the UI renders the assistant's reply token-by-token (SSE `chunk` events), with status indicators while it runs tools.
3. **Resolution cards** — when the assistant creates or updates a work object, a clickable [resolution card](support-case-v0.4.0-chat-to-work-resolution.md) appears below the bubble.
4. **Persistent conversation** — messages are stored as comments on a standing "Board Operations" issue, so the conversation survives page reloads and the assistant remembers recent context (last 20 comments).
5. **Auto-created anchor issue** — if no `taskId` is supplied, the server finds or creates a "Board Operations" issue per company to anchor the conversation and decision log.

## Feature Flag / Gating

The endpoint and UI are gated behind two layers:

| Layer | Condition | When off |
|---|---|---|
| Instance setting | `enableConferenceRoomChat` (default: `true`) in instance settings | `403 FEATURE_DISABLED` — "Conference Room Chat is not enabled" |
| Deployment mode | `local_trusted` only | `403 DEPLOYMENT_MODE_UNSUPPORTED` — "Board chat is only available on local single-operator instances" |

**Support note**: the API is *inert* while the flag is off, not just hidden — the endpoint exists but refuses all requests. If an operator reports the Conference Room is missing from the UI, check both the instance setting and the deployment mode. Cloud/restricted deployments do not have this feature at all.

## Known Limitations & Edge Cases

| Limitation | Description |
|---|---|
| **`local_trusted` only** | Board Chat is unavailable in cloud or restricted deployment modes by design (the assistant spawns a local `claude` subprocess with permissions skipped, so it is only safe where the requester IS the machine operator). |
| **Max 3 concurrent chats** | Beyond 3 simultaneous streams the server returns `429 BOARD_CHAT_BUSY` — "Too many concurrent board chats — retry shortly". |
| **120-second timeout** | Each request is capped at 120s. The subprocess is killed (SIGTERM) on timeout or client disconnect. Long, multi-step conversations may be cut off mid-generation. |
| **Requires local `claude` CLI** | The assistant spawns the operator's local `claude` binary (`--dangerously-skip-permissions`, model `sonnet`). If `claude` is not installed or not on PATH, chat fails. |
| **Last 20 comments context** | The assistant only sees the most recent 20 comments as conversation history. Older context is not available to it. |
| **Action events are per-turn** | Resolution cards clear when the user sends a new message; they do not persist in conversation history. |
| **Company scope enforced** | The body-supplied `companyId` must belong to the authenticated actor — requests for another company are rejected. |
| **Raw markup during streaming** | `%%ACTIONS%%` markup may briefly appear as plain text while the model generates; it is stripped from the persisted comment. |

## Troubleshooting

### "The Conference Room doesn't appear in my UI"

| Check | Action |
|---|---|
| Instance setting `enableConferenceRoomChat` | Must be `true` (Instance Settings > Experimental). CLI: `pnpm paperclipai instance settings:experimental`. |
| Deployment mode | Must be `local_trusted`. Cloud/restricted deployments do not have Board Chat. |

### "Chat returns 403"

- `code: "FEATURE_DISABLED"` → the instance setting is off. Enable it in Instance Settings.
- `code: "DEPLOYMENT_MODE_UNSUPPORTED"` → not a `local_trusted` deployment. Not supported in this mode — do not attempt to bypass.

### "Chat returns 429 BOARD_CHAT_BUSY"

- Three other chats are already streaming. Wait for one to finish, then retry. This is back-pressure, not a bug.

### "The assistant's reply cuts off mid-sentence"

- The 120s timeout fired. The response was truncated and the subprocess killed. Retry with a shorter ask, or break the request into smaller steps.

### "Chat fails with a spawn error / claude not found"

- The operator's local `claude` CLI must be installed and on PATH. Board Chat spawns `claude` directly. Verify with `which claude` on the host machine.

### "My message didn't show up / no reply"

- The message is persisted as a comment on the anchor issue *before* the model runs. If the model fails, the user comment still persists. Check the "Board Operations" issue for the comment, and check the 120s window.

## Error States

| Scenario | User Experience | Resolution |
|---|---|---|
| Flag disabled | `403 {"error":"Conference Room Chat is not enabled","code":"FEATURE_DISABLED"}` | Enable `enableConferenceRoomChat` in instance settings |
| Non-local deployment | `403 {"error":"Board chat is only available on local single-operator instances","code":"DEPLOYMENT_MODE_UNSUPPORTED"}` | Not supported in this deployment mode — no workaround |
| Missing fields | `400 {"error":"companyId and message are required"}` | Send both fields |
| Cross-company companyId | 403 (assertCompanyAccess) | Use the authenticated actor's own company |
| Too many concurrent | `429 {"error":"Too many concurrent board chats — retry shortly","code":"BOARD_CHAT_BUSY"}` | Retry after another chat finishes (max 3) |
| Model generation failure | SSE `error` event; no assistant reply persisted | Check server logs; retry the message |
| Timeout mid-generation | Stream ends after ~120s; partial response | Retry with a shorter ask |

## Escalation Path

| Issue | Severity | Action |
|---|---|---|
| Board Chat leaks data across companies | Critical | Escalate to CTO immediately — cross-tenant leak |
| Assistant performs unintended writes | Critical | Escalate to CTO — the board skill calls real APIs; review activity log |
| Endpoint returns 403 despite flag on | High | Escalate to Staff Engineer — verify flag persistence and route guarding |
| SSE stream crashes the Board Chat UI | High | Escalate to CTO — core chat surface UI error |
| `claude` subprocess hangs past 120s | Medium | Escalate to Staff Engineer — timeout kill not firing |
| Resolution cards missing for created objects | Medium | See [Chat-to-Work assessment](support-case-v0.4.0-chat-to-work-resolution.md) |

## Related Documentation

- [Board Chat API Reference](/docs/api/chat)
- [Chat-to-Work Resolution Cards Support Case Assessment](support-case-v0.4.0-chat-to-work-resolution.md)
- [v0.4.0 Release Notes](../releases/v0.4.0-alpha-deep-planning.md)
- [Experimental Features guide](/docs/guides/board-operator/experimental-features)