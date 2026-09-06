# Telegram Owner decision bridge

This directory captures the HuiDots Telegram Owner-decision compatibility overlay so the working local fix is reproducible instead of living only inside an installed `node_modules` package.

## Pins

- Paperclip base branch: `backport/pi-local-windows-11683`
- Paperclip base SHA used for this task: `3ab07984a95a29fc7235e8e212da5f72aff07dcd`
- Telegram plugin package: `paperclip-plugin-telegram@0.8.0`
- Telegram plugin v0.8.0 commit: `611a28d4a126180acdd5b62d2c7acdbf9b7af87e`
- Telegram annotated tag object: `705e9253a6010654d658c7d63ad01a0e03a447b2`

The upstream v0.8.0 tag is signed and currently remains the latest release. Current Paperclip upstream still logs `issue.thread_interaction_created`, but does not expose that activity as a plugin event. Current Telegram upstream does not implement `request_confirmation` Owner-decision handling.

## Scope

The overlay adds only the missing path:

1. Paperclip exposes `issue.thread_interaction.created` to plugins.
2. Telegram requests `issue.interactions.read` and `issue.interactions.respond`.
3. Pending `request_confirmation` interactions are sent to the linked/allowed Telegram chat with **Approve** and **Revise** buttons.
4. Callback handling rechecks company, issue, interaction kind and pending status before using the existing Paperclip interaction-response API.
5. `boardAccess.identity` remains a display label only. Canonical `actorUserId` comes from the existing Board Access token via `GET /api/cli-auth/me` (`userId` / `user.id`). Legacy board-access state recovers by token introspection without reconnecting.
6. Host-side board-user authorization remains authoritative. Missing/invalid token and company mismatch fail closed.

No new decision store, polling loop, supervisor, merge path or deployment mechanism is introduced.

## Plugin readiness note

`plugin-loader: no ready plugins to load` means the plugins table has no rows in `ready` status. Telegram is an npm-installed plugin (not a bundled auto-provision). If a prior activation failure marked it `error`, startup will skip it until `POST /api/plugins/:id/enable` succeeds. `apply-installed.ps1` performs that readiness correction against the existing HuiDots instance without recreating the company, database, secrets, or Telegram configuration. After apply, restart only the existing **HuiDots Paperclip** scheduled task and wait for embedded Postgres (~90s) before health checks.

## Files

- `paperclip-core.patch` — the two-line Paperclip event exposure change.
- `telegram-v0.8.0.patch` — source patch against the pinned Telegram v0.8.0 commit.
- `owner-decision-actor.ts` / `owner-decision-actor.test.ts` — pure actor-resolution contract + focused tests.
- `apply-installed.ps1` — idempotent Windows installer for the already-installed v0.8.0 package used by HuiDots (includes readiness enable).
- `verify.ps1` — bounded verification of the Paperclip source markers, installed Telegram runtime files, and optional live health/ready checks.

## Acceptance status

Static validation on the HuiDots machine passed after the equivalent local changes: JavaScript syntax checks, Paperclip shared/server typechecks and `git diff --check`. Paperclip restarted successfully and is listening on port 3100.

Live acceptance for the Owner-decision callback remains pending until the next genuine Paperclip `request_confirmation` produces the Telegram Owner-decision message and the Owner chooses Approve or Revise with the fixed canonical `actorUserId` path. Synthetic live Telegram UAT is intentionally not repeated.
