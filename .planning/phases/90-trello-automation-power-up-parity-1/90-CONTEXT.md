# Phase 90: Trello Automation / Power-up Parity (1) - Context

**Gathered:** 2026-05-05
**Status:** Ready for planning

<domain>
## Phase Boundary

Add Trello-style custom fields (POWER-01) to boards (text, number, date, dropdown types), make them viewable/editable on cards (POWER-02), and add a board calendar view filtered by due date (POWER-03). Phase 89 completed field extensions (checklist, due date, labels, members). Phase 90 adds automation/power-up parity features.

</domain>

<decisions>
## Implementation Decisions

### Custom field schema
- **D-01:** Custom field definitions stored in a new `rt2WorkBoardCustomFields` table — board-level field configuration (name, type, options)
- **D-02:** Custom field values stored in a new `rt2WorkBoardCardCustomFieldValues` table — per-card field values (issueId, fieldId, value)
- **D-03:** Field types: `text`, `number`, `date`, `dropdown` — supported in that order

### Custom field types
- **D-04:** Text fields: free-form string value
- **D-05:** Number fields: numeric value with optional decimal
- **D-06:** Date fields: timestamp (reuse dueDate timestamp pattern)
- **D-07:** Dropdown fields: optionId reference to `rt2WorkBoardCustomFieldOptions` table

### Custom field UI on cards
- **D-08:** Card detail panel shows custom fields as key-value pairs
- **D-09:** Inline editing on card detail (click to edit)
- **D-10:** Card quick-view shows first 2-3 custom fields as chips on the card face

### Board calendar view
- **D-11:** Calendar view is a separate tab/mode on the board (not replacing kanban)
- **D-12:** Calendar shows cards filtered by dueDate — same dueDate data from Phase 89 (timestamp field)
- **D-13:** Month view with cards grouped by due date (day cells show card titles)
- **D-14:** Click on card in calendar navigates to card detail

### Custom field management
- **D-15:** Board settings panel for managing custom fields (add/edit/delete/reorder)
- **D-16:** Dropdown options managed per field (add/remove options)

### OpenCode's Discretion
- Exact calendar UI component (full-width modal vs tab panel)
- Calendar library choice (date-fns Calendar vs custom grid)
- Custom field chips display format and truncation
- Dropdown option picker UI (modal vs inline dropdown)

</decisions>

<specifics>
## Specific Ideas

- Calendar view should feel like Trello calendar power-up — month grid, click day to see cards
- Custom field editing should feel lightweight — inline edit without modal
- Board settings UX for custom field management should be accessible from board header

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Schema / Data Model
- `packages/db/src/schema/rt2_work_board.ts` — Existing board card tables; new custom field tables will be added here
- `packages/db/src/schema/issues.ts` — Core `issues` table (parent for board cards)

### API / Service Layer
- `server/src/services/rt2-work-board.ts` — Existing board service with `getBoardOverview`, `updateCard`; new methods for custom field CRUD needed

### UI Components
- `ui/src/components/KanbanBoard.tsx` — Existing board component; calendar view will share/extend this pattern
- `ui/src/pages/rt2/DailyWorkPage.tsx` — Board page entry point

### Types
- `@paperclipai/shared` — `Rt2BoardCardMeta` type extended in Phase 89 with labels/members; needs further extension for custom fields

### Phase 89 Context (carried forward)
- `.planning/phases/89-trello-field-extension-parity/89-CONTEXT.md` — Phase 89 decisions on dueDate timestamp, labels, members
- Due date already uses `timestamp("due_date", { withTimezone: true })` — calendar view consumes this

</canonical_refs>

<codebase>
## Existing Code Insights

### Reusable Assets
- `rt2WorkBoardCards` table: `dueDate` is timestamp — calendar view can query this directly
- Phase 89 extended `Rt2BoardCardMeta` with `labels` and `members` — same pattern for custom fields
- Board service `getBoardOverview` already does parallel fetches with `Promise.all` pattern — follows same pattern for custom field values
- Existing board settings pattern can be extended for custom field management UI

### Established Patterns
- Board uses companyId-scoped tables with uuid PKs
- Card metadata in separate table (1:1 with issues.id)
- Service layer returns typed objects (not raw DB rows)
- API routes in `server/src/routes/rt2-tasks.ts`

### Integration Points
- Calendar view requires `getBoardOverview` extension to include dueDate-sorted cards for calendar query
- Custom field values need API routes for CRUD (create/update/delete field values per card)
- Board settings panel needs a new section for custom field management

</codebase>

<deferred>
## Deferred Ideas

- Formula-based custom fields (POWER-04) — Phase 91 scope
- WIP limits per lane (POWER-05) — Phase 91 scope
- Card templates (POWER-06) — Phase 91 scope

</deferred>

---
*Phase: 90-trello-automation-power-up-parity-1*
*Context gathered: 2026-05-05*