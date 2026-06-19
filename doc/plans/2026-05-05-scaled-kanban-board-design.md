# Scaled Kanban Board Design

Date: 2026-05-05
Branch: `feat/scaled-kanban-board`

## Context

The Issues page currently supports list and board modes. List mode already has grouping, sorting, filtering, nested parent/child rows, deferred row rendering, and incremental render limits. Board mode uses classic status columns with draggable cards. It fetches per-status board data, but the current UI still presents each lane as an unbounded stack of cards, which becomes tall and heavy when a company has hundreds of issues.

The goal is to keep the Kanban mental model while making high-volume boards usable. This is a UI-first change. It should not introduce schema changes or new API contracts in the first pass.

## Problem

When Paperclip has many issues, board columns get too tall and slow. The operator loses the ability to scan the board quickly, and rendering or dragging through long columns becomes unpleasant. The first version should solve this by reducing the number of visible cards per column and by collapsing low-signal columns, not by replacing Kanban with a different inventory surface.

## Design

Board mode remains status-column based. Each column shows its total issue count, a bounded set of visible cards, and a local affordance to reveal more cards in that column. The board should keep active workflow lanes expanded by default and collapse cold or noisy lanes once issue volume is high.

Default high-volume behavior activates when the filtered board has more than 100 issues:

- Compact cards are used by default.
- `backlog`, `done`, and `cancelled` auto-collapse to narrow rails.
- `todo`, `in_progress`, `in_review`, and `blocked` remain expanded by default.
- Each expanded column renders an initial 10 cards by default.
- The user can choose a page size of 10, 25, or 50 cards per column.
- The user can reveal one additional page at a time in each column without changing other columns.
- Drag and drop continues to work for visible cards.

The toolbar should expose compact controls for:

- toggling compact cards
- hiding or showing cold lanes
- choosing cards per column
- resetting board density to defaults

These preferences should persist through the existing issue view-state/localStorage mechanism and remain scoped by company.

## Component Shape

`IssuesList` remains the owner of issue board view state. It should store board-density preferences alongside the existing issue view state, including compact card preference, cold-lane mode, and cards-per-column page size.

`KanbanBoard` receives board tuning props from `IssuesList` and delegates per-lane display to `KanbanColumn`.

`KanbanColumn` owns only local presentation mechanics for a lane:

- whether the lane is rendered as an expanded column or collapsed rail
- how many cards are currently visible in that lane
- the local "show more" action

`KanbanCard` gets a compact variant. The compact card should still show the issue identifier, title, live state, priority, and assignee when available, but with tighter spacing and fewer vertical affordances.

## Data Flow

The first implementation uses the current issue data already available to board mode. No database, shared type, or route change is required.

Column totals are computed from the in-memory filtered board issues. If a column reaches the existing remote board query cap, the existing warning remains the truth source that more filtering may be required.

Future server-side column pagination can be added later if the UI-only version is not enough for very large instances.

## Error Handling

This feature should not introduce new network errors. Existing issue loading and update errors continue to surface through the Issues page.

For drag and drop:

- Moving a visible card keeps the current optimistic behavior.
- Hidden cards remain hidden until revealed.
- A collapsed lane rail is a valid drop target. Dropping onto it moves the issue to that status and keeps the lane collapsed.

## Testing

Focused tests should cover:

- board mode passes density preferences into `KanbanBoard`
- columns render only the initial visible card count
- "show more" reveals more cards in a single column
- high-volume cold lanes render as collapsed rails by default
- compact cards preserve identifier/title/live/priority/assignee signals
- drag/drop status updates still call `onUpdateIssue`

Manual verification should include opening the Issues board with a large fixture or mocked issue set and confirming that columns remain usable with hundreds of issues.

## Out of Scope

- Server-side per-column pagination
- New issue schema fields
- Replacing Kanban with a dense table or action-only board
- Changing issue status semantics
- Broad visual redesign of the Issues page
