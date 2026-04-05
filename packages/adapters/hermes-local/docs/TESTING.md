# Testing strategy

This adapter is structured for test-driven maintenance.

## Why unit-first

Most historical Hermes adapter bugs were not deep Hermes bugs.
They were adapter integration bugs:

- wrong source for wake context
- wrong env propagation
- stale session handling
- missing model discovery wiring
- output parsing drift

Those fail fastest in small unit tests.

## Current test layers

### Detection / config tests
- `detect-model.test.js`
- `list-models.test.js`
- `build-config.test.js`
- `session-codec.test.js`

### Prompt / parsing tests
- `prompt.test.js`
- `parse.test.js`
- `parse-source-audit.test.js`
- `paperclip-skill-compat.test.js`

### Runtime planning / execution tests
- `execute.test.js`

### Skills / lifecycle tests
- `skills.test.js`
- `hire-approved.test.js`

### Host-level regressions exercised from Paperclip
- `server/src/__tests__/agent-skills-routes.test.ts`
- `server/src/__tests__/approvals-service.test.ts`
- `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`
- `server/src/__tests__/issues-route-path-guard.test.ts`

### Browser E2E
- `tests/e2e/hermes-onboarding-hiring.spec.ts`
- `tests/e2e/hermes-approval-lifecycle.spec.ts`
- `tests/e2e/hermes-hierarchy-skills.spec.ts`

The hierarchy spec covers:

- Paperclip-managed skill import from GitHub (`obra/superpowers`)
- skill sync into a hired Hermes manager
- native Hermes skill usage by a hired worker
- manager -> worker reporting-chain validation
- delegated child issue creation and completion
- agent-authored native Hermes skill creation under `$HERMES_HOME/skills/...`
- installed Hermes skill execution where task-specific Paperclip comment/status requirements must still win over the skill's own "report and wait" wording
- prevention of terminal/env drift cases where `execute_code` would otherwise send Paperclip mutations with `PAPERCLIP_TASK_ID=None`

## Source-backed parser audit

When the local Hermes source tree is available at `~/.hermes/hermes-agent` (or
via `HERMES_SOURCE_ROOT`), the adapter also runs a source-backed parser audit:

- `parse-source-audit.test.js`

That audit verifies:

- banner rows from `hermes_cli/banner.py` still have suppression counterparts
- tool preview branches from `agent/display.py` still have parser samples
- non-TTY spinner bootstrap rows (`[tool] ...`) stay suppressed while `[done] ...` completions still parse into structured tool events
- chat-status lines from `cli.py` such as `[@ context: ...]`, `⚠ ...`, and session/init failures stay classified as `system` or `stderr` instead of assistant text
- truncated generic fallback labels like `skill_man` remain mapped back to the
  underlying Hermes tool name

If Hermes is not installed from source on the current machine, the audit skips
cleanly and the fixture-backed parser tests still run.

## Scheduling smoke checks

Hermes cron is not owned by Paperclip, but integration debugging should still verify the Hermes side:

```bash
PATH="$HOME/.hermes/node/bin:$PATH" hermes cron status
PATH="$HOME/.hermes/node/bin:$PATH" hermes cron list --all
```

If the gateway is not running, scheduled jobs will not fire even though normal Paperclip issue execution still works.
Paperclip now exports `HERMES_EXEC_ASK=1` for Hermes child runs so the cronjob tool itself is available in non-interactive agent sessions.

## Native Hermes smoke harness

For a direct Hermes-native validation outside Paperclip, run:

```bash
packages/adapters/hermes-local/tests/hermes-native-smoke.sh
```

That script:

- creates an isolated `HERMES_HOME`
- installs a real hub skill (`executing-plans`)
- proves Hermes can use that installed skill to create an artifact
- creates a cron job, triggers `hermes cron tick`, and verifies the saved output

Useful env overrides:

- `TARGET_HERMES_HOME=/tmp/hermes-smoke-home`
- `SOURCE_HERMES_HOME=$HOME/.hermes`
- `KEEP_HERMES_SMOKE_HOME=1`
- `KEEP_HERMES_SMOKE_WORKDIR=1`

## Running tests

```bash
node --test tests/*.test.js
PATH="$HOME/.hermes/node/bin:$PATH" pnpm exec vitest run \
  server/src/__tests__/agent-skills-routes.test.ts \
  server/src/__tests__/approvals-service.test.ts \
  server/src/__tests__/heartbeat-comment-wake-batching.test.ts \
  server/src/__tests__/issues-route-path-guard.test.ts
```

## Debugging a single test file

```bash
node --test tests/execute.test.js
```
