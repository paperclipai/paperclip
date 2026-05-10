# [Paperclip Issue] BBA Memory + Execute — UI Integration

**Suggested assignee:** CTO agent
**Priority:** P0 (CEO demo path)
**Effort estimate:** 4-8 hours (2 components, Component 1 is ~2h, Component 2 is ~4-6h with safety UX)

## Summary
Wire the new bba-memory + execute endpoints into BettingOpsDashboard. Two components, ship Component 1 first to unblock the demo's read-only half.

Full spec: `docs/bba-memory-ui-integration-spec.md`.

## Definition of done — Component 1 (Recent runs panel)
- BettingOpsDashboard.tsx renders recent-runs panel with stats card.
- Polls every 30s.
- Color-coded outcomes.
- Vitest snapshot test.
- No backend change.

## Definition of done — Component 2 (Execute button)
- "Place bet" button + confirmation modal.
- Calls executeBbaBet from ui/src/api/bbaMemory.ts.
- Shows live "placing..." progress.
- Result feedback (success/partial/failure).
- Behind feature flag or admin-only role check until first sandbox validation.

## Reference
- Backend PRs: paperclipai/paperclip#5583 (memory layer) + paperclipai/paperclip#5595 (route + endpoints + this spec).
- Typed client: `ui/src/api/bbaMemory.ts`.

## Notes
The backend endpoints land when both PRs merge to master. Component 1 is the demo unblock — start there.
