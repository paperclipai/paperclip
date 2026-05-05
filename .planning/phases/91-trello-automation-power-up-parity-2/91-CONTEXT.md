# Phase 91: Trello Automation / Power-up Parity (2) - Context

**Gathered:** 2026-05-05
**Status:** Ready for planning

<domain>
## Phase Boundary

Implement remaining Trello Power-up features: formula-based custom fields (POWER-04), WIP limits per lane (POWER-05), and card templates (POWER-06). Phase 90 completed custom fields, calendar view. Phase 91 completes the automation parity set.

</domain>

<decisions>
## Implementation Decisions

### Formula fields (POWER-04)
- **D-01:** Formula fields are a `fieldType: "formula"` in the custom field definition
- **D-02:** Formula expression stored as string (e.g., `"budget - spent"`) — simple arithmetic with field references
- **D-03:** Formula evaluation happens on READ (computed, not stored) — formula fields have no editable value, only display computed result
- **D-04:** Formula references other custom fields by their names (case-insensitive match)
- **D-05:** Supported operations: `+`, `-`, `*`, `/` with numeric field references; if any referenced field is null, result is null
- **D-06:** Formula fields display with a computed badge in card face chips

### WIP limits (POWER-05)
- **D-07:** WIP limit stored as part of board lane metadata (new `rt2WorkBoardLaneSettings` table or extend existing board config)
- **D-08:** Each lane (todo/in_progress/done) has optional `wipLimit: number | null` — null means no limit
- **D-09:** When adding/moving a card would exceed WIP limit: warn the user but allow override
- **D-10:** WIP count displayed in lane header (e.g., "진행 중 3/5" where 5 is the limit)
- **D-11:** When at limit: lane header shows warning color (amber), "+" add button shows tooltip "WIP limit reached"

### Card templates (POWER-06)
- **D-12:** Card templates stored in `rt2WorkBoardCardTemplates` table (board-level, not per-card)
- **D-13:** Template has: name, description, pre-filled custom field values, pre-set dueDate offset (e.g., "+3 days from today")
- **D-14:** Template selection UI appears when clicking "+ Card" — shows template list with preview
- **D-15:** Creating a card from template: pre-fills custom field values, sets dueDate relative to creation date

### OpenCode's Discretion
- Formula parser complexity (basic arithmetic only, or support functions like SUM, AVG?)
- WIP warning UI (inline warning vs modal vs toast)
- Template preview UI (expandable preview vs just name/description)

</decisions>

<specifics>
## Specific Ideas

- Formula field chip on card face shows computed value with "fx" badge
- WIP limit exceeded → amber glow on lane header, subtle warning badge
- Card template selector appears as a dropdown popover on "+" button, showing template cards

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Schema / Data Model
- `packages/db/src/schema/rt2_work_board.ts` — Existing board tables; formula fields extend custom field, WIP limits need new lane settings table, card templates need new table
- Phase 90 custom field tables already exist: use same patterns

### API / Service Layer
- `server/src/services/rt2-work-board.ts` — Existing board service; needs methods for WIP limits and card templates
- Custom field service already has `getCustomFieldDefinitions` — formula evaluation can be added here

### UI Components
- `ui/src/components/KanbanBoard.tsx` — Lane header already exists; add WIP count display
- Card template selector: new component in the "+" add button flow
- Formula field display: extend existing custom field chips with "fx" badge

</canonical_refs>

<codebase>
## Existing Code Insights

### Reusable Assets
- Custom field chip UI already implemented in Phase 90 (KanbanBoard.tsx line 384-388)
- Lane header component in KanbanBoard — can add WIP count there
- "+" card button exists in KanbanColumn at bottom of each lane

### Established Patterns
- Board service CRUD patterns already established for custom fields
- API routes follow `POST /boards/:boardId/...` pattern
- UI uses react-query for mutations

</codebase>

<deferred>
## Deferred Ideas

- POWER-07+: Additional Trello power-ups — future phases
- Formula fields with cross-card references (computed from other cards' data)

</deferred>

---
*Phase: 91-trello-automation-power-up-parity-2*
*Context gathered: 2026-05-05*