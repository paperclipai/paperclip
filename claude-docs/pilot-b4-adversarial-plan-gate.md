# Pilot B4 — Adversarial Plan-Gate Criteria

**Branch:** `pilot/b1-dogfood`
**Commit:** `7dfe0db4`
**Scope:** `server/src/onboarding-assets/architect/AGENTS.md`, `server/src/__tests__/architect-plan-gate-criteria.test.ts`

---

## Problem

HIVA-17 benchmark surfaced three architect failure modes that a well-run plan gate would
have caught before implementation started:

1. **Wrong projection source** — Implementor pulled a field from a derived/denormalized
   table when the canonical value lived in the root table. Reviewer caught it post-code,
   requiring a full implementation round-trip.

2. **Unbounded list query** — Plan described a list endpoint with no `LIMIT` or cursor.
   Under real data volume this would have become a full table scan.

3. **Trivially-passing test** — Plan included a test file that did not import the code
   under test. Could pass `vitest run` without exercising a single line of the
   implementation.

All three are cheap to catch at plan time and expensive after code lands.

---

## Fix

Three new blocking criteria added to the architect's plan-review checklist in
`server/src/onboarding-assets/architect/AGENTS.md`:

### Projection source-of-truth

> Every field in the plan's query or response is traced to its canonical source table.
> Populating a field from a derived, denormalized, or secondary table when the root table
> holds the value is a `blocking` concern. The plan must name the source table and column
> explicitly.

### Scalability and bounds

> Any list query must specify an explicit row limit or pagination strategy. An unbounded
> query without a `LIMIT` or cursor is a `blocking` concern unless the result set is
> provably small, explicitly justified in the plan.

### Test-harness wiring

> New test files must be in a directory the vitest config discovers and must import and
> invoke the code under test. A test file that can pass without exercising the
> implementation is a `blocking` concern.

---

## Test

`server/src/__tests__/architect-plan-gate-criteria.test.ts` — four content-assertion
tests using `loadDefaultAgentInstructionsBundle("architect")`:

- All three criteria phrases present in AGENTS.md
- Each criterion uses the word `` `blocking` `` (prevents silent downgrade to warning)

```
✓ 4 passed, 0 failed
```

---

## Note on .agents/ copy

`.agents/dev-team/agents/architect/AGENTS.md` received the same edits (live symlink
target used by the running Paperclip server). That path is gitignored — only the
`onboarding-assets/` copy is tracked. Both were updated in the same session.

---

## AC

- Architect AGENTS.md contains all three new criteria
- Each criterion explicitly labels the concern as `blocking`
- `lean-test.sh @paperclipai/server src/__tests__/architect-plan-gate-criteria.test.ts` → 4 passed

---

## Files Changed

| File | Change |
|---|---|
| `server/src/onboarding-assets/architect/AGENTS.md` | 3 new blocking criteria after Completeness bullet |
| `server/src/__tests__/architect-plan-gate-criteria.test.ts` | Content-assertion tests (new) |
| `packages/teams-catalog/.../dev-team/agents/architect/AGENTS.md` | Same 3 criteria + cross-consultation section (commit `abdc6e79`) |
