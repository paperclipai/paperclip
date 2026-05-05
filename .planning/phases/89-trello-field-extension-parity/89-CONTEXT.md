# Phase 89: Trello Field Extension Parity - Context

**Gathered:** 2026-05-04
**Status:** Ready for planning

<domain>
## Phase Boundary

Add Trello-style fields to work cards: checklist tracking (TRELLO-01), due date with time (TRELLO-02), colored labels (TRELLO-03), and card members (TRELLO-04). These are extensions to existing work card entities — the core card structure already exists.

</domain>

<decisions>
## Implementation Decisions

### Checklist tracking
- **D-01:** Progress percentage shown on card as "X/Y completed" with visual progress indicator
- **D-02:** Checklist items support title edit and checkbox toggle inline
- **D-03:** Reorder checklist items via drag handle

### Due date with time
- **D-04:** Date picker with optional time field (HH:mm)
- **D-05:** Overdue cards show red indicator; due today show yellow; future show default
- **D-06:** Due date editable from card detail panel and quick-edit popover

### Colored labels
- **D-07:** Existing `labels` + `issueLabels` tables used — no new schema needed
- **D-08:** Cards display label color chips (max 3 visible, +N overflow indicator)
- **D-09:** Label management (create/edit/delete) in board settings or card detail

### Card members
- **D-10:** Existing `rt2V33TaskParticipants` table used for member tracking
- **D-11:** Cards show member avatars (max 3, +N overflow)
- **D-12:** Member assignment via card detail panel with user picker

### OpenCode's Discretion
- Exact color palette for labels (reuse existing color constants or define new)
- Label chip size and shape (small rounded rect vs pill)
- Member avatar size and overlap style
- Calendar view (Phase 90/POWER-03) is separate — due date only needs date display for now

</decisions>

<specifics>
## Specific Ideas

No specific external references — Trello parity is well-understood from product requirements.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Schema / Data Model
- `packages/db/src/schema/rt2_work_board.ts` — Existing `rt2WorkBoardCards` and `rt2WorkBoardChecklistItems` tables
- `packages/db/src/schema/labels.ts` — Existing `labels` table
- `packages/db/src/schema/issue_labels.ts` — Existing `issue_labels` junction table
- `packages/db/src/schema/rt2_v33_task_participants.ts` — Existing `rt2V33TaskParticipants` table

### API Contracts
- `packages/db/src/schema/issues.ts` — Core `issues` table structure (parent for board cards)

### UI Components
- `ui/src/components/KanbanBoard.tsx` — Existing Kanban board with checklist props (`onAddChecklistItem`, `onUpdateChecklistItem`, `onReorderChecklist`)

### Shared Types
- `@paperclipai/shared` — `Rt2BoardCardMeta` type with existing `dueDate` field

</canonical_refs>

<codebase>
## Existing Code Insights

### Reusable Assets
- `rt2WorkBoardChecklistItems` table: already implements checklist item storage with `checked` (0/1), `title`, `position`
- `rt2WorkBoardCards` table: already has `dueDate` column
- `labels` + `issueLabels` tables: already implement label entity and many-to-many junction
- `rt2V33TaskParticipants` table: already tracks task members with `userId`, `state`, `joinedAt`
- KanbanBoard.tsx already accepts `onAddChecklistItem`, `onUpdateChecklistItem`, `onReorderChecklist` props

### Established Patterns
- RT2 board uses `companyId`-scoped tables with `uuid` primary keys
- Card metadata stored in separate `rt2WorkBoardCards` table (1:1 with `issues.id`)
- Checklist stored in separate `rt2WorkBoardChecklistItems` table (1:N with `issues.id`)
- Labels use junction table pattern (`issue_labels` with composite PK)
- Members use existing task participants table

### Integration Points
- Board card meta fetched via `Rt2BoardCardMeta` type in shared package
- Checklist items need API routes for CRUD operations
- Members need API routes to link/unlink users from tasks

</codebase>

<deferred>
## Deferred Ideas

- Card templates (POWER-06) — Phase 91 scope
- Calendar view filtered by due date (POWER-03) — Phase 90 scope
- Formula-based fields (POWER-04) — Phase 91 scope
- WIP limits per lane (POWER-05) — Phase 91 scope

</deferred>

---
*Phase: 89-trello-field-extension-parity*
*Context gathered: 2026-05-04*
