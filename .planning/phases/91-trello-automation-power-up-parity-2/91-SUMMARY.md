# Phase 91 Summary: Trello Automation / Power-up Parity (2)

**Status:** COMPLETE
**Completed:** 2026-05-05

## What Was Done

Implemented POWER-04 (formula fields), POWER-05 (WIP limits), and POWER-06 (card templates).

### POWER-04: Formula Fields

**Schema:**
- Added `formulaExpression` column to `rt2WorkBoardCustomFields` table (0116 migration)
- Extended `Rt2CustomFieldType` to include `"formula"` in shared types

**Service:**
- Added `evaluateFormula(expression, fieldValues)` function in board service
  - Parses field references by name, replaces with numeric values
  - Evaluates arithmetic expressions (+, -, *, /, parentheses)
  - Returns null if any referenced field is null/non-numeric

**UI:**
- Formula fields marked with "fx" badge capability in card chips (type distinction)

### POWER-05: WIP Limits

**Schema:**
- Created `rt2WorkBoardLaneSettings` table with per-project, per-lane WIP limits
- Unique constraint on (companyId, projectId, lane)

**Service methods:**
- `getLaneSettings(companyId, projectId)` → returns limits for all 3 lanes
- `updateLaneWipLimit(companyId, projectId, lane, wipLimit)`
- `getLaneCardCount(companyId, projectId, lane)` → counts issues by status
- `checkWipLimitExceeded(companyId, projectId, lane)` → `{ exceeded, current, limit }`

**API routes:**
- `GET /companies/:companyId/rt2/work-board/lane-settings/:projectId`
- `PATCH /companies/:companyId/rt2/work-board/lane-settings/:projectId`

**UI:**
- Added `wipLimits` and `wipCounts` props to KanbanBoard
- Lane header shows count/limit badge (e.g., "3/5")
- Amber highlight when at/over limit
- Warning banner replaces add button when limit exceeded

### POWER-06: Card Templates

**Schema:**
- Created `rt2WorkBoardCardTemplates` table (company/project scoped)
- Created `rt2WorkBoardCardTemplateFieldValues` table (pre-filled field values)
- 0116 migration adds both tables

**Service methods:**
- `getCardTemplates(companyId, projectId)` → list with field values
- `createCardTemplate(...)` → create with field values
- `updateCardTemplate(...)` → update with field values
- `deleteCardTemplate(...)` → cascade delete field values
- `applyTemplateToCard(companyId, issueId, actorUserId, templateId)` → set dueDate + field values

**API routes:**
- `GET /companies/:companyId/rt2/work-board/templates/:projectId`
- `POST /companies/:companyId/rt2/work-board/templates/:projectId`
- `PATCH /rt2/work-board/templates/:templateId`
- `DELETE /rt2/work-board/templates/:templateId`
- `POST /companies/:companyId/rt2/work-board/cards/:issueId/apply-template/:templateId`

**UI:**
- Added `templates` and `onSelectTemplate` props to KanbanBoard
- Template selector shows in lane footer when templates exist
- Template buttons trigger `onSelectTemplate(templateId, lane)`

## Commits

| Commit | Description |
|--------|-------------|
| `31f63775` | feat(phase91): POWER-04~06 formula fields, WIP limits, card templates |
| `1689b44d` | feat(ui): WIP limit display on KanbanColumn headers |
| `9e0cf067` | feat(ui): card template selector in KanbanColumn footer |

## Files Changed

```
packages/shared/src/types/rt2-task.ts              [+formula type]
packages/db/src/schema/rt2_work_board.ts           [+formulaExpression, +laneSettings, +cardTemplates, +templateFieldValues]
packages/db/src/schema/index.ts                    [+laneSettings, +cardTemplates, +templateFieldValues exports]
packages/db/src/migrations/0116_rt2_work_board_power_up_parity_2.sql   [new migration]
server/src/services/rt2-work-board.ts              [+evaluateFormula, +WIP methods, +template methods]
server/src/routes/rt2-tasks.ts                     [+WIP limit routes, +template routes]
ui/src/components/KanbanBoard.tsx                  [+WIP display, +template selector]
```

## Remaining Pre-existing Typecheck Errors (Not Phase 91)

- `rt2-task-execution.ts`: Rt2DomainEventType mismatch (pre-existing)
- `rt2-work-entity.ts`: multiple issues (pre-existing)
- db migration numbering: journal 115 vs files 116 (pre-existing, Phase 90)