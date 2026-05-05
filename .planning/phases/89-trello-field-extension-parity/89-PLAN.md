# Phase 89: Trello Field Extension Parity — Plan

**Wave:** 1 of 1
**Plans:** 1
**Status:** Ready for execution

## Wave 1 (Autonomous)

| Plan | Objective | Tasks | Key Files |
|------|-----------|-------|-----------|
| 89-01 | Data layer: dueDate timestamp, labels/members in Rt2BoardCardMeta, service CRUD | 5 | schema, types, service |

---

## Plan 89-01: Data Layer Foundation

**Objective:** Upgrade `dueDate` column to timestamp, extend `Rt2BoardCardMeta` with `labels` and `members` arrays, add service-layer CRUD methods.

### Task 89-01-1: Migrate rt2WorkBoardCards.dueDate to timestamp

**Type:** `schema`
**Verify:** `pnpm db:generate` produces migration for date→timestamp

- [ ] Read `packages/db/src/schema/rt2_work_board.ts`
- [ ] Change `dueDate: date("due_date")` to `dueDate: timestamp("due_date", { withTimezone: true })`
- [ ] Run `pnpm db:generate`
- [ ] Verify migration file created in `packages/db/src/migrations/`

### Task 89-01-2: Extend Rt2BoardCardMeta with labels

**Type:** `types`
**Verify:** TypeScript compile passes for shared package

- [ ] Read `@paperclipai/shared` — find `Rt2BoardCardMeta` type
- [ ] Add `Rt2BoardCardLabel` interface: `{ id, name, color }`
- [ ] Add `labels: Rt2BoardCardLabel[]` to `Rt2BoardCardMeta`
- [ ] Run `pnpm typecheck` — zero errors

### Task 89-01-3: Extend Rt2BoardCardMeta with members

**Type:** `types`
**Verify:** TypeScript compile passes for shared package

- [ ] Add `Rt2BoardCardMember` interface: `{ userId, name, avatarUrl? }`
- [ ] Add `members: Rt2BoardCardMember[]` to `Rt2BoardCardMeta`
- [ ] Run `pnpm typecheck` — zero errors

### Task 89-01-4: Update getBoardOverview to fetch labels and members

**Type:** `service`
**Verify:** API returns labels+member data, unit tests pass

- [ ] Read server service for board overview/card fetch
- [ ] `getBoardOverview` (or card fetch): join `issue_labels` + `labels` → array of `{ id, name, color }`
- [ ] `getBoardOverview`: join `rt2V33TaskParticipants` where `state='active'` → array of `{ userId, name, avatarUrl }`
- [ ] Write/find unit test for board card metadata fetch
- [ ] Run `pnpm test` — all pass

### Task 89-01-5: Add label/member API methods to board service

**Type:** `service`
**Verify:** CRUD methods exist and are wired to API routes

- [ ] Add `addLabelToCard(companyId, issueId, labelId)` → issue_labels insert
- [ ] Add `removeLabelFromCard(companyId, issueId, labelId)` → issue_labels delete
- [ ] Add `addMemberToCard(companyId, issueId, userId)` → rt2V33TaskParticipants insert
- [ ] Add `removeMemberFromCard(companyId, issueId, userId)` → rt2V33TaskParticipants update state='ended'
- [ ] Verify API routes exist or wire these methods to existing routes
- [ ] Run `pnpm typecheck && pnpm test` — all pass

---

## TRELLO Coverage

| ID | Requirement | Covered By |
|----|-------------|-----------|
| TRELLO-01 | Checklist tracking (completion %) | Task 4: checklist progress already in card meta, extended in fetch |
| TRELLO-02 | Due date with time | Task 1: date→timestamp migration + Task 4: fetch extends |
| TRELLO-03 | Colored labels | Tasks 2+4: type + fetch |
| TRELLO-04 | Card members | Tasks 3+4: type + fetch |

---

## Deferred to Phase 90+

- Calendar view filtered by due date (POWER-03)
- UI: label chip display on KanbanCard (Phase 90 — UI wave)
- UI: member avatar display on KanbanCard (Phase 90 — UI wave)
- UI: color-coded due date urgency (Phase 90 — UI wave)
- UI: card detail panel label/member management (Phase 90 — UI wave)

---

## Files Modified

```
packages/db/src/schema/rt2_work_board.ts          [dueDate type]
packages/db/src/migrations/                      [generated migration]
packages/shared/src/                              [Rt2BoardCardMeta types]
server/src/services/rt2-work-board.ts            [getBoardOverview + CRUD]
```

---

*Plan created: 2026-05-04*
*Status: ready for /gsd-execute-phase 89*
