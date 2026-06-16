# Pilot B3 — Persistent Cross-Task Memory for CTO + Architect

**Branch:** `pilot/b1-dogfood`
**Scope:** `packages/db/src/migrations/0103_agent_notes.sql`, `packages/db/src/schema/agents.ts`, `packages/shared/src/types/agent.ts`, `packages/shared/src/validators/agent.ts`, `server/src/services/heartbeat.ts`, CTO + architect `AGENTS.md` (catalog + onboarding)

---

## Problem

The pilot's CTO and architect cold-start every wake with no accumulated knowledge.
Each plan review re-derives the same facts: where migrations live, which table holds
`gateProfile`, what the query patterns are. This is pure overhead — `/dev-roles` amortizes
it across a single context; MyHive currently doesn't.

---

## Fix

A `notes TEXT` column on the `agents` table gives each agent a durable append-only
scratchpad. At wake time, the agent's current notes are injected into the
`contextSnapshot` as `agentNotes` — the same mechanism used for all other per-wake
context. After completing a task, the agent PATCHes its own notes to append what
it learned.

### 1. Migration 0103 — `agents.notes TEXT`

```sql
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "notes" text;
```

No migration risk: nullable column, `IF NOT EXISTS`, existing rows unaffected.

### 2. Shared type + validator

`Agent` interface gains `notes: string | null`. `updateAgentSchema` gains:

```typescript
notes: z.string().max(50000).nullable().optional()
```

50k char limit prevents accidental giant notes. Null clears the field.

### 3. Wake injection — `heartbeat.ts enqueueWakeup`

After `getAgent()` returns the agent row (which includes `notes` via `select()`):

```typescript
if (agent.notes) {
  enrichedContextSnapshot.agentNotes = agent.notes;
}
```

`agentNotes` is then stored in `heartbeat_runs.contextSnapshot` and readable by the
agent during its run.

### 4. CTO + architect `AGENTS.md`

Both agents (catalog + onboarding versions = 4 files) receive a `## Cross-task memory`
section instructing:

- At wake: read `agentNotes` from context before starting work
- After task: PATCH `/api/agents/<id>` with updated notes (append, not overwrite)
- Format: `## <task title> <YYYY-MM-DD>\n<one-line lesson>`
- Max 3 lines per entry; keep entries concrete (`"Migration files go to packages/db/src/migrations/"`)

---

## AC

- `PATCH /api/agents/:id { notes: "..." }` persists notes (validated, max 50k)
- `GET /agents/:id` returns `notes` field
- Agent wake contextSnapshot includes `agentNotes` when notes is set; absent when null
- CTO + architect AGENTS.md instruct reading and appending notes per task
- Across two sequential tasks, the architect accumulates a fact from task 1 without
  re-deriving it in task 2

---

## Files Changed

| File | Change |
|---|---|
| `packages/db/src/migrations/0103_agent_notes.sql` | Add `notes TEXT` column |
| `packages/db/src/migrations/meta/_journal.json` | Register entry idx 103 |
| `packages/db/src/schema/agents.ts` | Add `notes: text("notes")` to schema |
| `packages/shared/src/types/agent.ts` | Add `notes: string \| null` to `Agent` interface |
| `packages/shared/src/validators/agent.ts` | Add `notes` to `updateAgentSchema` |
| `server/src/services/heartbeat.ts` | Inject `agentNotes` into contextSnapshot at wake |
| `packages/teams-catalog/.../cto/AGENTS.md` | Add cross-task memory section |
| `packages/teams-catalog/.../architect/AGENTS.md` | Add cross-task memory section |
| `server/src/onboarding-assets/cto/AGENTS.md` | Add cross-task memory section |
| `server/src/onboarding-assets/architect/AGENTS.md` | Add cross-task memory section |
| `server/src/__tests__/agent-notes.test.ts` | 8 tests: validator (5) + route (3) |
