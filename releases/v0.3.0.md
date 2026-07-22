# v0.3.0

> Released: 2026-03-09

## Highlights

- **New adapters: Cursor, OpenCode, and Pi** — Paperclip now supports three additional local coding agents. Cursor and OpenCode integrate as first-class adapters with model discovery, run-log streaming, and skill injection. Pi adds a local RPC mode with cost tracking. All three appear in the onboarding wizard alongside Claude Code and Codex. ([#62](https://github.com/paperclipai/paperclip/pull/62), [#141](https://github.com/paperclipai/paperclip/pull/141), [#240](https://github.com/paperclipai/paperclip/pull/240), [#183](https://github.com/paperclipai/paperclip/pull/183), @aaaaron, @Konan69, @richardanaya)
- **OpenClaw gateway adapter** — A new gateway-only OpenClaw flow replaces the legacy adapter. It uses strict SSE streaming, supports device-key pairing, and handles invite-based onboarding with join-token validation. ([#270](https://github.com/paperclipai/paperclip/pull/270))
- **Inbox and unread semantics** — Issues now track per-user read state. Unread indicators appear in the inbox, dashboard, and browser tab (blue dot). The inbox badge includes join requests and approvals, and inbox ordering is alert-focused. ([#196](https://github.com/paperclipai/paperclip/pull/196), @hougangdev)
- **PWA support** — The UI ships as an installable Progressive Web App with a service worker and enhanced manifest. The service worker uses a network-first strategy to prevent stale content.
- **Agent creation wizard** — A new choice modal and full-page configuration flow make it easier to add agents. The sidebar AGENTS header now has a quick-add button.

## Improvements

- **Mermaid diagrams in markdown** — Fenced `mermaid` blocks render as diagrams in issue comments and descriptions.
- **Live run output** — Run detail pages stream output over WebSocket in real time, with coalesced deltas and deduplicated feed items.
- **Copy comment as Markdown** — Each comment header has a one-click copy-as-markdown button.
- **Retry failed runs** — Failed and timed-out runs now show a Retry button on the run detail page.
- **Project status clickable** — The status chip in the project properties pane is now clickable for quick updates.
- **Scroll-to-bottom button** — Issue detail and run pages show a floating scroll-to-bottom button when you scroll up.
- **Database backup CLI** — `paperclipai db:backup` lets you snapshot the database on demand, with optional automatic scheduling.
- **Disable sign-up** — A new `auth.disableSignUp` config option (and `AUTH_DISABLE_SIGNUP` env var) lets operators lock registration. ([#279](https://github.com/paperclipai/paperclip/pull/279), @JasonOA888)
- **Deduplicated shortnames** — Agent and project shortnames are now auto-deduplicated on create and update instead of rejecting duplicates. ([#264](https://github.com/paperclipai/paperclip/pull/264), @mvanhorn)
- **Human-readable role labels** — The agent list and properties pane show friendly role names. ([#263](https://github.com/paperclipai/paperclip/pull/263), @mvanhorn)
- **Assignee picker sorting** — Recent selections appear first, then alphabetical.
- **Mobile layout polish** — Unified GitHub-style issue rows across issues, inbox, and dashboard. Improved popover scrolling, command palette centering, and property toggles on mobile. ([#118](https://github.com/paperclipai/paperclip/pull/118), @MumuTW)
- **Invite UX improvements** — Invite links auto-copy to clipboard, snippet-only flow in settings, 10-minute invite TTL, and clearer network-host guidance.
- **Permalink anchors on comments** — Each comment has a stable anchor link and a GET-by-ID API endpoint.
- **Docker deployment hardening** — Authenticated deployment mode by default, named data volume, `PAPERCLIP_PUBLIC_URL` and `PAPERCLIP_ALLOWED_HOSTNAMES` exposed in compose files, health-check DB wait, and Node 24 base image. ([#400](https://github.com/paperclipai/paperclip/pull/400), [#283](https://github.com/paperclipai/paperclip/pull/283), [#284](https://github.com/paperclipai/paperclip/pull/284), @AiMagic5000, @mingfang)
- **Updated model lists** — Added `claude-sonnet-4-6`, `claude-haiku-4-6`, and `gpt-5.4` to adapter model constants. ([#293](https://github.com/paperclipai/paperclip/pull/293), [#110](https://github.com/paperclipai/paperclip/pull/110), @cpfarhood, @artokun)
- **Playwright e2e tests** — New end-to-end test suite covering the onboarding wizard flow.

## Fixes

- **Secret redaction in run logs** — Env vars sourced from secrets are now redacted by provenance, with consistent `secretKeys` tracking. ([#261](https://github.com/paperclipai/paperclip/pull/261), @mvanhorn)
- **SPA catch-all 500s** — The server serves cached `index.html` in the catch-all route and uses `root` in `sendFile`, preventing 500 errors on dotfile paths and SPA refreshes. ([#269](https://github.com/paperclipai/paperclip/pull/269), [#78](https://github.com/paperclipai/paperclip/pull/78), @mvanhorn, @MumuTW)
- **Unmatched API routes return 404 JSON** — Previously fell through to the SPA handler. ([#269](https://github.com/paperclipai/paperclip/pull/269), @mvanhorn)
- **Agent wake logic** — Agents wake when issues move out of backlog, skip self-wake on own comments, and skip wakeup for backlog-status changes. Pending-approval agents are excluded from heartbeat timers. ([#159](https://github.com/paperclipai/paperclip/pull/159), [#154](https://github.com/paperclipai/paperclip/pull/154), [#267](https://github.com/paperclipai/paperclip/pull/267), [#72](https://github.com/paperclipai/paperclip/pull/72), @Logesh-waran2003, @cschneid, @mvanhorn, @STRML)
- **Run log fd leak** — Fixed a file-descriptor leak in log append that caused `spawn EBADF` errors. ([#266](https://github.com/paperclipai/paperclip/pull/266), @mvanhorn)
- **500 error logging** — Error logs now include the actual error message and request context instead of generic pino-http output.
- **Boolean env parsing** — `parseBooleanFromEnv` no longer silently treats common truthy values as false. ([#91](https://github.com/paperclipai/paperclip/pull/91), @zvictor)
- **Onboarding env defaults** — `onboard` now correctly derives secrets from env vars and reports ignored exposure settings in `local_trusted` mode. ([#91](https://github.com/paperclipai/paperclip/pull/91), @zvictor)
- **Windows path compatibility** — Migration paths use `fileURLToPath` for Windows-safe resolution. ([#265](https://github.com/paperclipai/paperclip/pull/265), [#413](https://github.com/paperclipai/paperclip/pull/413), @mvanhorn, @online5880)
- **Secure cookies on HTTP** — Disabled secure cookie flag for plain HTTP deployments to prevent auth failures. ([#376](https://github.com/paperclipai/paperclip/pull/376), @dalestubblefield)
- **URL encoding** — `buildUrl` splits path and query to prevent `%3F` encoding issues. ([#260](https://github.com/paperclipai/paperclip/pull/260), @mvanhorn)
- **Auth trusted origins** — Effective trusted origins and allowed hostnames are now applied correctly in public mode. ([#99](https://github.com/paperclipai/paperclip/pull/99), @zvictor)
- **UI stability** — Fixed blank screen when prompt templates are emptied, search URL sync causing re-renders, issue title overflow in inbox, and sidebar badge counts including approvals. ([#262](https://github.com/paperclipai/paperclip/pull/262), [#196](https://github.com/paperclipai/paperclip/pull/196), [#423](https://github.com/paperclipai/paperclip/pull/423), @mvanhorn, @hougangdev, @RememberV)

## Contributors

Thank you to everyone who contributed to this release!

@aaaaron, @AiMagic5000, @artokun, @cpfarhood, @cschneid, @dalestubblefield, @Dotta, @eltociear, @fahmmin, @gsxdsm, @hougangdev, @JasonOA888, @Konan69, @Logesh-waran2003, @mingfang, @MumuTW, @mvanhorn, @numman-ali, @online5880, @RememberV, @richardanaya, @STRML, @tylerwince, @zvictor
