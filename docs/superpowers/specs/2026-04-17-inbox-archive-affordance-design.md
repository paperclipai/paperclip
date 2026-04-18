# Inbox Archive Affordance Design

Date: 2026-04-17
Status: Approved for implementation

## Goal

Make the inbox archive path obvious from the list view instead of relying on a hover-only `X` on desktop or swipe on touch devices.

## Decision

- In the `Needs Action` and `Unread` inbox tabs, issue rows will show an always-visible `Archive` action.
- In the `Needs Action` and `Unread` inbox tabs, non-issue rows will show an always-visible `Dismiss` action because they are hidden locally rather than archived server-side.
- The blue unread dot remains, but only as a passive status marker; it no longer doubles as the row's primary control.
- Opening or acting on an unread row should still clear unread state so removing the dot click target does not strand the read workflow.
- Swipe-to-archive and keyboard shortcuts remain available as accelerators.
- `Recent` and `All` keep their lighter read-focused interaction model and do not gain explicit archive or dismiss actions.

## Rationale

The current UI makes a primary inbox action effectively undiscoverable on desktop, and the blue unread dot is visually strong enough that it reads like the thing you are meant to click. A persistent outlined action is clearer than an icon-only affordance and avoids conflating issue archive with non-issue dismiss behavior.

## Scope

- Update inbox row action rendering for issue and non-issue rows in `ui/src/pages/Inbox.tsx` and `ui/src/components/IssueRow.tsx`.
- Add or update focused UI tests covering the explicit action labels.
- Update the inbox section of the UI spec.

## Out of Scope

- Changes to issue detail quick-archive behavior.
- Changes to swipe gestures or keyboard shortcuts beyond keeping them intact.
- Adding archive or dismiss controls to tabs other than `Needs Action`.
