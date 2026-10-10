# v2026.415.0

> Released: 2026-04-15

## Highlights

- **Faster issues page first paint** — The issues list now renders the initial view significantly faster by deferring non-critical work and optimizing workspace lookups.
- **Issue detail performance** — Reduced unnecessary rerenders on the issue detail page and kept queued issue chat mounted to avoid layout thrash during agent runs.
- **Inbox search expansion** — Added an "Other results" section to inbox search, surfacing matches beyond the current filter scope.

## Improvements

- **Properties pane polish** — Workspace link, copy-on-click for identifiers, and an inline parent navigation arrow in the issue properties sidebar.
- **Routine UX** — Routine name now appears above the "Run routine" title in the run dialog; routine execution issues are shown in issue lists by default.
- **Filter label clarity** — Renamed the routine-run filter to "Hide routine runs" so the default state shows no active filter badge.
- **Stranded issue diagnostics** — Stranded issue comments now include the latest run failure message for faster triage.
- **Issues search responsiveness** — Debounce and rendering improvements make the issues page search feel snappier.
- **Live run refresh** — Visible issue runs now refresh automatically on status updates without a manual reload.
- **Heartbeat payload hygiene** — Raw `result_json` writes are preserved exactly as received; payloads are bounded to prevent oversized records.
- **Heartbeat log scoping** — Narrowed heartbeat log endpoint lookups to reduce query overhead.
- **Vite dev watch** — UI test files are now excluded from the Vite dev watcher, reducing unnecessary rebuilds during development.

## Fixes

- **Self-comment code block scrolling** — Fixed horizontal scrolling for code blocks inside an agent's own comment thread.
- **Markdown long-string wrapping** — Long unbroken strings in markdown comments now wrap correctly instead of overflowing the container.
- **Dev asset serving order** — Fixed dev mode to serve public assets before the HTML shell, preventing 404s on static files during local development.
