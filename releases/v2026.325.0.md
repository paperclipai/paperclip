# v2026.325.0

> Released: 2026-03-25

## Highlights

- **Company import/export** — Full company portability with a file-browser UX for importing and exporting agent companies. Includes rich frontmatter preview, nested file picker, merge-history support, GitHub shorthand refs, and CLI `company import`/`company export` commands. Imported companies open automatically after import, and heartbeat timers are disabled for imported agents by default. ([#840](https://github.com/paperclipai/paperclip/pull/840), [#1631](https://github.com/paperclipai/paperclip/pull/1631), [#1632](https://github.com/paperclipai/paperclip/pull/1632), [#1655](https://github.com/paperclipai/paperclip/pull/1655))
- **Company skills library** — New company-scoped skills system with a skills UI, agent skill sync across all local adapters (Claude, Codex, Pi, Gemini), pinned GitHub skills with update checks, and built-in skill support. ([#1346](https://github.com/paperclipai/paperclip/pull/1346))
- **Routines and recurring tasks** — Full routines engine with triggers, routine runs, coalescing, and recurring task portability. Includes API documentation and routine export support. ([#1351](https://github.com/paperclipai/paperclip/pull/1351), [#1622](https://github.com/paperclipai/paperclip/pull/1622), @aronprins)

## Improvements

- **Inline join requests in inbox** — Join requests now render inline in the inbox alongside approvals and other work items.
- **Onboarding seeding** — New projects and issues are seeded with goal context during onboarding for a better first-run experience.
- **Agent instructions recovery** — Managed agent instructions are recovered from disk on startup; instructions are preserved across adapter switches.
- **Heartbeats settings page** — Shows all agents regardless of interval config; added a "Disable All" button for quick bulk control.
- **Agent history via participation** — Agent issue history now uses participation records instead of direct assignment lookups.
- **Alphabetical agent sorting** — Agents are sorted alphabetically by name across all views.
- **Company org chart assets** — Improved generated org chart visuals for companies.
- **Improved CLI API connection errors** — Better error messages when the CLI cannot reach the Paperclip API.
- **Markdown mention links** — Custom URL schemes are now allowed in Lexical LinkNode, enabling mention pills with proper linking behavior. Atomic deletion of mention pills works correctly.
- **Issue workspace reuse** — Workspaces are correctly reused after isolation runs.
- **Failed-run session resume** — Explicit failed-run sessions can now be resumed via honor flag.
- **Docker image CI** — Added Docker image build and deploy workflow. ([#542](https://github.com/paperclipai/paperclip/pull/542), @albttx)
- **Project filter on issues** — Issues list can now be filtered by project. ([#552](https://github.com/paperclipai/paperclip/pull/552), @mvanhorn)
- **Inline comment image attachments** — Uploaded images are now embedded inline in comments. ([#551](https://github.com/paperclipai/paperclip/pull/551), @mvanhorn)
- **AGENTS.md fallback** — Claude-local adapter gracefully falls back when AGENTS.md is missing. ([#550](https://github.com/paperclipai/paperclip/pull/550), @mvanhorn)
- **Company-creator skill** — New skill for scaffolding agent company packages from scratch.
- **Reports page rename** — Reports section renamed for clarity. ([#1380](https://github.com/paperclipai/paperclip/pull/1380), @DanielSousa)
- **Eval framework bootstrap** — Promptfoo-based evaluation framework with YAML test cases for systematic agent behavior testing. ([#832](https://github.com/paperclipai/paperclip/pull/832), @mvanhorn)
- **Board CLI authentication** — Browser-based auth flow for the CLI so board users can authenticate without manually copying API keys. ([#1635](https://github.com/paperclipai/paperclip/pull/1635))

## Fixes

- **Embedded Postgres initdb in Docker slim** — Fixed initdb failure in slim containers by adding proper initdbFlags types. ([#737](https://github.com/paperclipai/paperclip/pull/737), @alaa-alghazouli)
- **OpenClaw gateway crash** — Fixed unhandled rejection when challengePromise fails. ([#743](https://github.com/paperclipai/paperclip/pull/743), @Sigmabrogz)
- **Agent mention pill alignment** — Fixed vertical misalignment between agent mention pills and project mention pills.
- **Task assignment grants** — Preserved task assignment grants for agents that have already joined.
- **Instructions tab state** — Fixed tab state not updating correctly when switching between agents.
- **Imported agent bundle frontmatter** — Fixed frontmatter leakage in imported agent bundles.
- **Login form 1Password detection** — Fixed login form not being detected by password managers; Enter key now submits correctly. ([#1014](https://github.com/paperclipai/paperclip/pull/1014))
- **Pill contrast (WCAG)** — Improved mention pill contrast using WCAG contrast ratios on composited backgrounds.
- **Documents horizontal scroll** — Prevented documents row from causing horizontal scroll on mobile.
- **Toggle switch sizing** — Fixed oversized toggle switches on mobile; added missing `data-slot` attributes.
- **Agent instructions tab responsive** — Made agent instructions tab responsive on mobile.
- **Monospace font sizing** — Adjusted inline code font size and added dark mode background.
- **Priority icon removal** — Removed priority icon from issue rows for a cleaner list view.
- **Same-page issue toasts** — Suppressed redundant toasts when navigating to an issue already on screen.
- **Noisy adapter log** — Removed noisy "Loaded agent instructions file" log message from all adapters.
- **Pi local adapter** — Fixed Pi adapter missing from `isLocal` check. ([#1382](https://github.com/paperclipai/paperclip/pull/1382), @lucas-stellet)
- **CLI auth migration idempotency** — Made migration 0044 idempotent to avoid failures on re-run.
- **Dev restart tracking** — `.paperclip` and test-only paths are now ignored in dev restart detection.
- **Duplicate CLI auth flag** — Fixed duplicate `--company` flag on `auth login`.
- **Gemini local execution** — Fixed Gemini local adapter execution and diagnostics.
- **Sidebar ordering** — Preserved sidebar ordering during company portability operations.
- **Company skill deduplication** — Fixed duplicate skill inventory refreshes.
- **Worktree merge-history migrations** — Fixed migration handling in worktree contexts. ([#1385](https://github.com/paperclipai/paperclip/pull/1385))

## Upgrade Guide

Seven new database migrations (`0038`–`0044`) will run automatically on startup:

- **Migration 0038** adds process tracking columns to heartbeat runs (PID, started-at, retry tracking).
- **Migration 0039** adds the routines engine tables (routines, triggers, routine runs).
- **Migrations 0040–0042** extend company skills, recurring tasks, and portability metadata.
- **Migration 0043** adds the Codex managed-home and agent instructions recovery columns.
- **Migration 0044** adds board API keys and CLI auth challenge tables for browser-based CLI auth.

All migrations are additive (new tables and columns) — no existing data is modified. Standard `paperclipai` startup will apply them automatically.

If you use the company import/export feature, note that imported companies have heartbeat timers disabled by default. Re-enable them manually from the Heartbeats settings page after verifying adapter configuration.

## Contributors

Thank you to everyone who contributed to this release!

@alaa-alghazouli, @albttx, @AOrobator, @aronprins, @cryppadotta, @DanielSousa, @lucas-stellet, @mvanhorn, @richardanaya, @Sigmabrogz
