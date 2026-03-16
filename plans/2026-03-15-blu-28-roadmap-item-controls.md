# BLU-28 Roadmap Item Controls Plan

Date: 2026-03-15
Issue: BLU-28
Owner: Product Designer

## What I verified

- The live roadmap detail at `/BLU/roadmap/:goalId` still renders the status on the main surface as a read-only badge.
- The side properties panel already exposes status editing, but that control is easy to miss and is not visible enough to satisfy the board request.
- There is no delete affordance on the roadmap detail surface or in the properties panel.
- The current feature branch already contains a hero-row status picker in [`ui/src/pages/GoalDetail.tsx`](/Users/pedrogonzalez/paperclip/app/ui/src/pages/GoalDetail.tsx) plus a regression test in [`ui/src/pages/GoalDetail.test.tsx`](/Users/pedrogonzalez/paperclip/app/ui/src/pages/GoalDetail.test.tsx).
- `origin/development` does not contain that hero-row status change, which explains why the running product still feels read-only on the main detail page.
- The API already supports `PATCH /roadmap/:id` and `DELETE /roadmap/:id`, so this is primarily a UX-surface and guardrail gap rather than a missing CRUD endpoint.

## Product decisions

- Status is a primary lifecycle control and should live on the main hero row beside level and horizon on both desktop and mobile.
- Delete is a secondary destructive action and should live in a dedicated danger area or overflow action, not beside the primary status control.
- Operators should never need to infer why delete is unavailable. If the item still has dependent work, the UI must say so explicitly and recommend cancelling the item instead.
- The delete flow must redirect predictably after success: go to the parent roadmap item when one exists, otherwise return to `/roadmap`.

## Implementation slices

### 1. Restore visible status editing on the main detail surface

- Bring the existing hero-row `GoalStatusPicker` work from `blu-28-roadmap-status-surface` onto the branch that will land in `development`.
- Keep the properties-panel status picker as a secondary control, but do not rely on it as the only editable surface.
- While a status mutation is in flight, disable repeated input and show clear pending feedback.

### 2. Add a delete affordance with explicit confirmation

- Add a `Delete roadmap item` action to the detail flow in a danger zone or overflow menu.
- Use a confirmation dialog that names the roadmap item and explains the outcome before the destructive request runs.
- The confirm action should be disabled while the delete mutation is pending.

### 3. Add dependency guardrails before destructive deletion

- Before enabling delete, inspect already-loaded child roadmap items and linked projects from the detail queries.
- If the roadmap item has child items or linked projects, keep delete disabled and show explanatory copy.
- If the backend still rejects deletion because of other linked records, surface a clear error message instead of a generic failure. A server-side `409` with human-readable copy is preferable to a raw database error.
- When delete is blocked, direct operators to either unlink dependent work or set the roadmap item status to `cancelled`.

### 4. Cover the missing states

- Mobile: make sure the hero metadata row wraps cleanly and the status control remains visible without opening the side panel.
- Loading: keep the status/delete affordances out of view until the detail payload is loaded.
- Error: show actionable mutation failure copy for both status updates and delete attempts.
- Empty follow-through: after successful deletion, route back to the correct parent or roadmap list so the user does not land on a dead detail URL.

### 5. Lock the behavior with tests

- Keep the existing regression test that asserts the main-surface status control exists.
- Add UI tests for the delete entry point, the dependency-blocked state, and the post-delete redirect behavior.
- Add or update server coverage if delete errors are normalized into a `409` response.

## Recommended handoff scope for Founding Engineer

- Reuse the already-built hero status picker from commit `17ca926` instead of redesigning that piece.
- Implement the delete affordance and its guardrails in the same pass so the roadmap detail surface becomes fully manageable.
- Treat this as complete only after desktop and mobile verification on a real roadmap item detail page.

## Acceptance criteria

- The roadmap detail hero row exposes an obvious status control on desktop and mobile.
- Operators can update status without opening the side properties panel.
- Operators can see a delete action, understand when it is unavailable, and complete a confirmed delete when dependencies allow it.
- Delete failures surface clear dependency or error copy instead of a silent no-op or raw server error.
- The roadmap detail flow has automated coverage for the main-surface status control and delete guardrails.
