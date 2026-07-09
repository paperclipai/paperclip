# P0 → P1 Handoff — Conference Room

Date: 2026-07-09  
Phase completed: **P0 Foundation + P0.5 UX/attachments + P1 host_run**

## Stable contract delivered

`POST /api/board/chat/stream` returns JSON (not SSE) with:

| `mode` | HTTP | Meaning |
|--------|------|---------|
| `silent` | 200 | No structured `agent://` mention; comment persisted only |
| `host_run` | 202 | Single valid mention; host run started for mentioned agent |

Error responses:

| HTTP | `code` | Meaning |
|------|--------|---------|
| 400 | `FANOUT_NOT_ENABLED` | Multiple structured mentions in one message |
| 409 | `AGENT_NOT_INVOKABLE` | Mentioned agent cannot be woken (paused, budget, etc.) |

Fields:

- `issueId` — standing "Board Operations" issue
- `commentId` / `roomMessageId` — same value; thread correlation key
- `hostAgentId` / `hostRunId` / `status` — present on `host_run` (202)

**Compat note:** `adapter_wake_pending` remains in shared validators (`board-chat.ts`) for backward compatibility, but the route now orchestrates immediately and returns `host_run` (202) instead of deferring wake.

## P0.5 delivered (UX / attachments)

- `BoardChat.tsx` — assistant-ui shell, attachment upload, mention autocomplete
- `BoardChatComposer.tsx` — composer with `@mention` picker and file attachments
- Silent-until-`@` behavior: plain messages persist without waking agents

## P1 delivered (host_run)

1. `room-orchestrator.ts` — host run from `roomMessageId` + mentioned agent
2. `heartbeat.wakeup` with `wakeReason: "conference_room_mentioned"` and `contextSnapshot.roomMessageId`
3. Agent reply as `issue_comments` with `authorAgentId` + optional `parentCommentId`
4. BoardChat poll/refetch while host run is non-terminal
5. Typing/status UI tied to real run state
6. Cost pill on agent bubbles via `heartbeatsApi.get` + `visibleRunCostUsd`

## Key files

| Layer | Path |
|-------|------|
| Orchestrator | `server/src/services/room-orchestrator.ts` |
| Route | `server/src/routes/board-chat.ts` |
| Validators | `packages/shared/src/validators/board-chat.ts` |
| UI page | `ui/src/pages/BoardChat.tsx` |
| UI composer | `ui/src/pages/board-chat/BoardChatComposer.tsx` |
| Skill | `skills/paperclip-board/SKILL.md` (RF-P1-11 Conference Room mentions) |

## Still deferred

- Fan-out (multi-mention wake)
- DelegationTrace
- Concierge CLI isolated at `ENABLE_BOARD_CONCIERGE_CLI = false` in `board-chat.ts`

## Verification commands

```bash
pnpm exec vitest run server/src/__tests__/room-message.test.ts
pnpm exec vitest run server/src/__tests__/room-orchestrator.test.ts
pnpm exec vitest run server/src/__tests__/board-chat-silent-until-at.test.ts
pnpm exec vitest run ui/src/pages/BoardChat.mentions.test.tsx
pnpm exec vitest run ui/src/pages/BoardChat.test.tsx
```
