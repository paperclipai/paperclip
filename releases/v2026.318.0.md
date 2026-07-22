# v2026.318.0

> Released: 2026-03-18

## Highlights

- **Plugin framework and SDK** — Full plugin system with runtime lifecycle management, CLI tooling, settings UI, breadcrumb and slot extensibility, domain event bridge, and a kitchen-sink example. The Plugin SDK now includes document CRUD methods and a testing harness. ([#904](https://github.com/paperclipai/paperclip/pull/904), [#910](https://github.com/paperclipai/paperclip/pull/910), [#912](https://github.com/paperclipai/paperclip/pull/912), [#909](https://github.com/paperclipai/paperclip/pull/909), [#1074](https://github.com/paperclipai/paperclip/pull/1074), @gsxdsm, @mvanhorn, @residentagent)
- **Upgraded costs and budgeting** — Improved cost tracking and budget management surfaces. ([#949](https://github.com/paperclipai/paperclip/pull/949))
- **Issue documents and attachments** — Issues now support inline document editing, file staging before creation, deep-linked documents, copy and download actions, and live-event refresh. ([#899](https://github.com/paperclipai/paperclip/pull/899))
- **Hermes agent adapter** — New `hermes_local` adapter brings support for the Hermes CLI as an agent backend. ([#587](https://github.com/paperclipai/paperclip/pull/587), @teknium1)
- **Execution workspaces (EXPERIMENTAL)** — Isolated execution workspaces for agent runs, including workspace operation tracking, reusable workspace deduplication, and work product management. Project-level workspace policies are configurable. ([#1038](https://github.com/paperclipai/paperclip/pull/1038))
- **Heartbeat token optimization** — Heartbeat cycles now skip redundant token usage.

## Improvements

- **Session compaction is adapter-aware** — Compaction logic now respects per-adapter context limits.
- **Company logos** — Upload and display company logos with SVG sanitization and enhanced security headers for asset responses. ([#162](https://github.com/paperclipai/paperclip/pull/162), @JonCSykes)
- **App version label** — The sidebar now displays the running Paperclip version. ([#1096](https://github.com/paperclipai/paperclip/pull/1096), @saishankar404)
- **Project tab caching** — Active project tab is remembered per-project; tabs have been renamed and reordered. ([#990](https://github.com/paperclipai/paperclip/pull/990))
- **Copy-to-clipboard on issues** — Issue detail headers now include a copy button; HTML entities no longer leak into copied text. ([#990](https://github.com/paperclipai/paperclip/pull/990))
- **Me and Unassigned assignee options** — Quick-filter assignee options for the current user and unassigned issues. ([#990](https://github.com/paperclipai/paperclip/pull/990))
- **Skip pre-filled fields in new issue dialog** — Tab order now skips assignee and project fields when they are already populated. ([#990](https://github.com/paperclipai/paperclip/pull/990))
- **Worktree cleanup command** — New `worktree:cleanup` command, env-var defaults, and auto-prefix for worktree branches. ([#1038](https://github.com/paperclipai/paperclip/pull/1038))
- **Release automation** — Automated canary and stable release workflows with npm trusted publishing and provenance metadata. ([#1151](https://github.com/paperclipai/paperclip/pull/1151), [#1162](https://github.com/paperclipai/paperclip/pull/1162))
- **Documentation link** — Sidebar documentation link now points to external docs.paperclip.ing.
- **Onboarding starter task delay** — Starter tasks are no longer created until the user launches.

## Fixes

- **Embedded PostgreSQL hardening** — Startup adoption, data-dir verification, and UTF-8 encoding are now handled reliably. (@vkartaviy)
- **`os.userInfo()` guard** — Containers with UID-only users no longer crash; HOME is excluded from the cache key. ([#1145](https://github.com/paperclipai/paperclip/pull/1145), @wesseljt)
- **opencode-local HOME resolution** — `os.userInfo()` is used for model discovery instead of relying on the HOME env var. ([#1145](https://github.com/paperclipai/paperclip/pull/1145), @wesseljt)
- **dotenv cwd fallback** — The server now loads `.env` from `cwd` when `.paperclip/.env` is missing. ([#834](https://github.com/paperclipai/paperclip/pull/834), @mvanhorn)
- **Plugin event subscription wiring** — Fixed subscription cleanup, filter nullability, and stale diagram. ([#988](https://github.com/paperclipai/paperclip/pull/988), @leeknowsai)
- **Plugin slot rendering** — Corrected slot registration and rendering for plugin UI extensions. ([#916](https://github.com/paperclipai/paperclip/pull/916), [#918](https://github.com/paperclipai/paperclip/pull/918), @gsxdsm)
- **Archive project UX** — Archive now navigates to the dashboard and shows a toast; replaced `window.confirm` with inline confirmation.
- **Markdown editor spacing** — Image drop/paste adds proper newlines; header top margins increased.
- **Workspace form refresh** — Forms now refresh when projects are accessed via URL key and allow empty saves.
- **Legacy migration reconciliation** — Fixed migration reconciliation for existing installations.
- **`archivedAt` type coercion** — String-to-Date conversion before Drizzle update prevents type errors.
- **Agent HOME env var** — `AGENT_HOME` is now set correctly for child agent processes. ([#864](https://github.com/paperclipai/paperclip/pull/864))
- **Sidebar scrollbar hover track** — Fixed scrollbar track visibility on hover. ([#919](https://github.com/paperclipai/paperclip/pull/919))
- **Sticky save bar on non-config tabs** — Hidden to prevent layout push.
- **Empty goals display** — Removed "None" text from empty goals.
- **Runs page padding** — Removed unnecessary right padding.
- **Codex bootstrap logs** — Treated as stdout instead of stderr.
- **Dev runner syntax** — Fixed syntax issue in plugin dev runner. ([#914](https://github.com/paperclipai/paperclip/pull/914), @gsxdsm)
- **Process list** — Fixed process list rendering. ([#903](https://github.com/paperclipai/paperclip/pull/903), @gsxdsm)

## Upgrade Guide

Ten new database migrations (`0028`–`0037`) will run automatically on startup:

- **Migrations 0028–0029** add plugin framework tables.
- **Migrations 0030–0037** extend the schema for issue documents, execution workspaces, company logos, cost tracking, and plugin enhancements.

All migrations are additive (new tables and columns) — no existing data is modified. Standard `paperclipai` startup will apply them automatically.

If you use the `.env` file, note that the server now falls back to loading `.env` from the current working directory when `.paperclip/.env` is not found.

## Contributors

Thank you to everyone who contributed to this release!

@gsxdsm, @JonCSykes, @leeknowsai, @mvanhorn, @residentagent, @saishankar404, @teknium1, @vkartaviy, @wesseljt
