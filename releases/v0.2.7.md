# v0.2.7

> Released: 2026-03-04

## Improvements

- **Onboarding resilience** — The setup wizard now continues after a failed environment test instead of getting stuck. If your Anthropic API key doesn't work, you can retry or clear it and proceed with a different configuration.
- **Docker onboarding flow** — Cleaner defaults for the Docker smoke test and improved console guidance during `npx` onboarding runs.
- **Issue search in skills** — The Paperclip skill reference now documents the `q=` search parameter for finding issues by keyword.

## Fixes

- **Markdown list rendering** — Fixed list markers (`-`, `*`) not rendering correctly in the editor and comment views.
- **Archived companies hidden** — The new issue dialog no longer shows archived companies in the company selector.
- **Embedded Postgres requirement** — The server now correctly requires the `embedded-postgres` dependency when running in embedded DB mode, preventing startup failures.
