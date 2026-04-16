# Visibility Tab — Live File-Edit Grid

Real-time view of files being edited by agents across all active runs.

## Problem

Operators have no live visibility into what agents are writing. Progress updates arrive as Paperclip comments at workflow-stage boundaries (router, specialist, critic), but the actual file-level work is invisible until a run completes. This makes multi-agent orchestration feel like a black box.

## Solution

A new **Visibility** tab in the Paperclip UI that displays a grid of file cards, grouped by agent, showing rolling diffs in real-time as agents write code.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Feature scope | Paperclip-native | Any adapter can emit file-edit events, not just Vibe Stack |
| Card trigger | File writes only | Reads are noisy; writes are what operators care about |
| Card lifecycle | Persist until run ends | One card per file per run; diffs accumulate into the same card |
| Card grouping | By agent (rows) | Maps to the org chart mental model — who is doing what |
| Diff display | Rolling/scrolling | Feels like watching the agent code live |
| Empty state | Clean "No active runs" | This is a live view, not history |
| UI styling | Paperclip-native components | shadcn/ui Card, Badge, ScrollArea — no custom design system |

## Architecture

Piggybacks on the existing `heartbeat.run.event` pipeline. No new event types, no new WebSocket channels, no new persistence layer.

```
Adapter (file write)
  → POST /api/companies/:companyId/runs/:runId/events
    → Server in-memory buffer (per active run)
    → WebSocket push (existing live-events)
      → UI filters for eventType === "file.edit"
        → Visibility page renders file cards
```

## 1. Event Contract

File-edit events use the existing `heartbeat.run.event` envelope:

```typescript
{
  type: "heartbeat.run.event",
  payload: {
    runId: string,
    agentId: string,
    seq: number,                // monotonic per-run
    eventType: "file.edit",
    data: {
      filePath: string,         // workspace-relative, e.g. "src/api/auth.ts"
      editType: "create" | "modify" | "delete",
      diff: string,             // unified diff, last ~50 lines
      linesAdded: number,
      linesRemoved: number,
      timestamp: string         // ISO 8601
    }
  }
}
```

Constraints:
- `filePath` is workspace-relative (no absolute host paths leaked)
- `diff` capped at ~50 lines to keep payloads small; the card's rolling view shows the tail
- `editType` lets the UI badge cards differently (CREATE / MODIFY / DELETE)
- `seq` enables correct ordering even if WebSocket delivers out of order

## 2. Server Changes

### In-Memory Buffer

Lightweight per-run buffer that collects `file.edit` events for active runs. Evicted when the run reaches a terminal state (success, failed, blocked).

Purpose: hydrate the Visibility tab when opened mid-run. Without this, you only see events that arrive after you open the tab.

Eviction: buffer for a run is deleted when the server processes a `heartbeat.run.status` event with a terminal status (`success`, `failed`, `blocked`). This piggybacks on the existing run lifecycle — no new timers or cleanup jobs.

### Hydration Endpoint

```
GET /api/companies/:companyId/runs/active/file-events
```

Returns all buffered `file.edit` events for currently active runs, grouped by `runId`:

```typescript
{
  runs: {
    [runId: string]: {
      agentId: string,
      events: FileEditEvent[]
    }
  }
}
```

### No Other Server Changes

- The existing `heartbeat.run.event` handler already accepts arbitrary payloads and pushes to WebSocket
- No new database tables
- No new event types in the shared constants
- No persistence beyond the in-memory buffer

## 3. UI Components

### Page: `Visibility.tsx`

New page at `/visibility`. Added to the Sidebar under the Work section (below Improvements). Uses the `Eye` icon from Lucide.

Responsibilities:
- Subscribe to `LiveUpdatesProvider` WebSocket events, filter for `eventType === "file.edit"`
- On mount, fetch `GET /runs/active/file-events` to hydrate mid-run state
- Maintain state: `Map<runId, Map<filePath, FileEditEvent[]>>`
- Render agent rows with file cards
- Show "No active runs" empty state when no runs are active

Data sources:
- `heartbeatsApi.liveRunsForCompany()` for active run metadata (agent name, linked issue)
- WebSocket events for real-time file edits
- Hydration endpoint for mid-run catch-up

### Component: `AgentFileRow.tsx`

One row per active agent. Shows:
- Agent name + role color badge (matches existing agent badge colors)
- Linked issue title
- Horizontal scroll area of file cards
- If the agent has no file edits yet, show current workflow stage from `heartbeat.run.status` events (e.g. "Spec Build", "Router")

### Component: `FileCard.tsx`

Individual file card using shadcn `Card`:
- **Header**: file path (truncated with tooltip for long paths) + `editType` badge (CREATE green, MODIFY blue, DELETE red)
- **Stats**: `+N / -N` line counts
- **Body**: rolling diff view — auto-scrolls as new edits arrive, green/red line coloring
- **Key**: `runId + filePath` — same key means same card, new diffs append

Card width: fixed (e.g. 320px) so the grid is uniform. Height: fixed with the diff area scrollable.

### Component: `DiffView.tsx`

Monospace scrolling diff display:
- Green background for additions, red for removals, neutral for context
- Uses Paperclip's existing syntax color tokens
- Auto-scrolls to bottom on new content (with a "scroll lock" toggle if the user scrolls up manually)
- `<pre>` element inside shadcn `ScrollArea`

### Layout

```
Visibility (page)
  └─ AgentFileRow (per active agent)
       ├─ Agent header (name, badge, issue link)
       └─ ScrollArea (horizontal)
            ├─ FileCard
            │    ├─ File path + editType badge
            │    ├─ +N / -N stats
            │    └─ DiffView (rolling)
            ├─ FileCard
            └─ ...
```

### Empty State

Centered in the page area:
- "No active runs" in muted text
- Matches the empty-state pattern used by other Paperclip pages

### Routing & Navigation

- Route: add `<Route path="visibility" element={<Visibility />} />` in `boardRoutes()` in `App.tsx`
- Redirect: add `<Route path="visibility" element={<UnprefixedBoardRedirect />} />` at top level
- Sidebar: add `<SidebarNavItem to="/visibility" icon={Eye} label="Visibility" />` in the Work section

## 4. Adapter Integration

### Contract

Any adapter can emit `file.edit` events by POSTing to the existing run-events endpoint. The event schema in section 1 is the contract. Adapters that don't emit file events simply produce no cards on the Visibility tab.

### Vibe Stack Implementation

Instrumentation point: `agents/tools/file_tools.py` in `FileWriter.execute()`.

After a successful file write:

```python
self.paperclip_client.emit_run_event(
    run_id=self.run_id,
    event_type="file.edit",
    data={
        "filePath": workspace_relative_path,
        "editType": edit_type,  # "create" | "modify" | "delete"
        "diff": truncated_diff,  # last ~50 lines of unified diff
        "linesAdded": lines_added,
        "linesRemoved": lines_removed,
    }
)
```

Best-effort delivery — if the event fails to send, the file write still succeeds. Same error-handling pattern as `heartbeat_progress.py`.

Diff generation: `difflib.unified_diff` between previous content (for modify) or empty string (for create). Truncated to last ~50 lines before sending.

### Other Adapters

DeerFlow, Claude Local, or any future adapter can emit the same events. The adapter just needs to:
1. Intercept file-write operations
2. Compute a diff
3. POST the event to `/api/companies/:companyId/runs/:runId/events`

## Non-Goals

- **History/persistence**: this is a live view. Completed runs are not stored or queryable from this tab. Activity and run detail pages serve that purpose.
- **File content display**: cards show diffs, not full file contents.
- **Read operations**: file reads don't generate cards.
- **Click-to-edit**: cards are read-only. No inline editing of agent output.
- **Cross-run file tracking**: cards are scoped to a single run. If two agents in different runs touch the same file, they get separate cards in separate rows.

## Implementation Sequence

1. **Event contract** — define TypeScript type for `file.edit` data in `packages/shared`
2. **Server buffer** — in-memory buffer for active-run file events + hydration endpoint
3. **UI page** — Visibility page, routing, sidebar nav item
4. **UI components** — AgentFileRow, FileCard, DiffView
5. **Vibe Stack adapter** — instrument FileWriter to emit events
6. **Testing** — unit tests for buffer eviction, UI component tests, integration test with mock events
