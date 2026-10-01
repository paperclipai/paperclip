# v0.3.1

> Released: 2026-03-12

## Highlights

- **Gemini CLI adapter** — Full local adapter support for Google's Gemini CLI. Includes API-key detection, turn-limit handling, sandbox and approval modes, skill injection into `~/.gemini/`, and yolo-mode default. ([#452](https://github.com/paperclipai/paperclip/pull/452), [#656](https://github.com/paperclipai/paperclip/pull/656), @aaaaron)
- **Run transcript polish** — Run transcripts render markdown, fold command stdout, redact home paths and user identities, and display humanized event labels across both detail and live surfaces. ([#648](https://github.com/paperclipai/paperclip/pull/648), [#695](https://github.com/paperclipai/paperclip/pull/695))
- **Inbox refinements** — Improved tab behavior, badge counts aligned with visible unread items, better mobile layout, and smoother new-issue submit state. ([#613](https://github.com/paperclipai/paperclip/pull/613))
- **Improved onboarding wizard** — Onboarding now shows Claude Code and Codex as recommended adapters, collapses other types, and features animated step transitions with clickable tabs. Adapter environment checks animate on success and show debug output only on failure. ([#700](https://github.com/paperclipai/paperclip/pull/700))

## Improvements

- **Instance heartbeat settings sidebar** — View and manage heartbeat configuration directly from the instance settings page with compact grouped run lists. ([#697](https://github.com/paperclipai/paperclip/pull/697))
- **Project and agent configuration tabs** — New tabbed configuration UI for projects and agents, including execution workspace policy settings. ([#613](https://github.com/paperclipai/paperclip/pull/613))
- **Agent runs tab** — Agent detail pages now include a dedicated runs tab.
- **Configurable attachment content types** — The `PAPERCLIP_ALLOWED_ATTACHMENT_TYPES` env var lets operators control which file types can be uploaded. ([#495](https://github.com/paperclipai/paperclip/pull/495), @subhendukundu)
- **Default max turns raised to 300** — Agents now default to 300 max turns instead of the previous limit. ([#701](https://github.com/paperclipai/paperclip/pull/701))
- **Issue creator shown in sidebar** — The issue properties pane now displays who created each issue. ([#145](https://github.com/paperclipai/paperclip/pull/145), @cschneid)
- **Company-aware 404 handling** — The UI now shows company-scoped not-found pages instead of a generic error.
- **Tools for Worktree workflow for developers** — New `paperclipai worktree:make` command provisions isolated development instances with their own database, secrets, favicon branding, and git hooks. Worktrees support minimal seed mode, start-point selection, and automatic workspace rebinding. ([#496](https://github.com/paperclipai/paperclip/pull/496), [#530](https://github.com/paperclipai/paperclip/pull/530), [#545](https://github.com/paperclipai/paperclip/pull/545))

## Fixes

- **Gemini Docker build** — Include the Gemini adapter manifest in the Docker deps stage so production builds succeed. ([#706](https://github.com/paperclipai/paperclip/pull/706), @zvictor)
- **Approval retries made idempotent** — Duplicate approval submissions no longer create duplicate records. ([#502](https://github.com/paperclipai/paperclip/pull/502), @davidahmann)
- **Heartbeat cost recording** — Costs are now routed through `costService` instead of being recorded inline, fixing missing cost attribution. ([#386](https://github.com/paperclipai/paperclip/pull/386), @domocarroll)
- **Claude Code env var leak** — Child adapter processes no longer inherit Claude Code's internal environment variables. ([#485](https://github.com/paperclipai/paperclip/pull/485), @jknair)
- **`parentId` query filter** — The issues list endpoint now correctly applies the `parentId` filter. ([#491](https://github.com/paperclipai/paperclip/pull/491), @lazmo88)
- **Remove `Cmd+1..9` shortcut** — The company-switch keyboard shortcut conflicted with browser tab switching and has been removed. ([#628](https://github.com/paperclipai/paperclip/pull/628), @STRML)
- **IME composition Enter** — Pressing Enter during IME composition in the new-issue title no longer moves focus prematurely. ([#578](https://github.com/paperclipai/paperclip/pull/578), @kaonash)
- **Restart hint after hostname change** — The CLI now reminds users to restart the server after changing allowed hostnames. ([#549](https://github.com/paperclipai/paperclip/pull/549), @mvanhorn)
- **Default `dangerouslySkipPermissions` for unattended agents** — Agents running without a terminal now default to skipping permission prompts instead of hanging. ([#388](https://github.com/paperclipai/paperclip/pull/388), @ohld)
- **Remove stale `paperclip` property from OpenClaw Gateway** — Cleaned up an invalid agent parameter that caused warnings. ([#626](https://github.com/paperclipai/paperclip/pull/626), @openagen)
- **Issue description overflow** — Long descriptions no longer break the layout.
- **Worktree JWT persistence** — Environment-sensitive JWT config is now correctly carried into worktree instances.
- **Dev migration prompt** — Fixed embedded `db:migrate` flow for local development.
- **Markdown link dialog positioning** — The link insertion dialog no longer renders off-screen.
- **Pretty logger metadata** — Server log metadata stays on one line instead of wrapping.

## Upgrade Guide

Two new database migrations (`0026`, `0027`) will run automatically on startup:

- **Migration 0026** adds the `workspace_runtime_services` table for worktree-aware runtime support.
- **Migration 0027** adds `execution_workspace_settings` to issues and `execution_workspace_policy` to projects.

Both are additive (new table and new columns) — no existing data is modified. Standard `paperclipai` startup will apply them automatically.

## Contributors

Thank you to everyone who contributed to this release!

@aaaaron, @adamrobbie-nudge, @cschneid, @davidahmann, @domocarroll, @jknair, @kaonash, @lazmo88, @mvanhorn, @ohld, @openagen, @STRML, @subhendukundu, @zvictor
