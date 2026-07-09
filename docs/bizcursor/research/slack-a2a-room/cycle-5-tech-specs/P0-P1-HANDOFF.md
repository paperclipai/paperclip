# P0 → P1 Handoff — Conference Room

Date: 2026-07-09  
Phase completed: **P0 Foundation**

## Stable contract delivered

`POST /api/board/chat/stream` now returns JSON (not SSE) with:

| `mode` | HTTP | Meaning |
|--------|------|---------|
| `silent` | 200 | No structured `agent://` mention; comment persisted only |
| `adapter_wake_pending` | 202 | Single valid mention; **no host run yet** |

Fields:

- `issueId` — standing "Board Operations" issue
- `commentId` / `roomMessageId` — same value; use for thread correlation in P1
- `mentionedAgentIds` — present only on `adapter_wake_pending` (length 1)

Multi-mention returns `400` with `code: "FANOUT_NOT_ENABLED"`.

## P1 must implement

1. `room-orchestrator` service — host run from `roomMessageId` + `mentionedAgentIds[0]`
2. `heartbeat.wakeup` with `wakeReason: "conference_room_mentioned"` and `contextSnapshot.roomMessageId`
3. Agent reply as `issue_comments` with `authorAgentId` + optional `parentCommentId`
4. BoardChat poll/refetch while host run is non-terminal; cost pill on agent bubble
5. Typing/status UI tied to real run state (replace P0 placeholder notice)

## P0 intentionally deferred

- No `heartbeat.wakeup` on mention (avoids orphan runs without reply path)
- Concierge CLI isolated at `ENABLE_BOARD_CONCIERGE_CLI = false` in `board-chat.ts`
- Fan-out, DelegationTrace, cost pill

## Verification commands

```bash
pnpm exec vitest run server/src/__tests__/room-message.test.ts
pnpm exec vitest run server/src/__tests__/board-chat-silent-until-at.test.ts
pnpm exec vitest run ui/src/pages/BoardChat.mentions.test.tsx
```
