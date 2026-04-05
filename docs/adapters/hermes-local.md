---
title: Hermes Local
summary: Run Hermes Agent locally through Paperclip with dynamic model discovery and approval-aware wake handling
---

`hermes_local` runs [Hermes Agent](https://github.com/NousResearch/hermes-agent) through Paperclip's local adapter runtime.

## What this integration supports

- dynamic model discovery from `~/.hermes/config.yaml`
- durable session reuse across wakes
- Paperclip-aware prompts for tasks, comments, approvals, and hiring
- structured parsing of Hermes tool previews, reasoning panels, diffs, and response panels
- approval lifecycle wakeups for approve, reject, and revision-request flows
- approval wake payload summaries so approved hires are reused instead of re-requested
- subordinate hiring through Paperclip's board approval workflow
- mixed skill usage:
  - Paperclip-managed skills imported into the company and synced into Hermes
  - native Hermes skills already installed under `~/.hermes/skills`
  - agent-authored native Hermes skills created during live issue work
- manager/worker hierarchy flows where Hermes agents hire, delegate, and wait on each other
- terminal-only Paperclip API mutations so Hermes `execute_code` sandboxes cannot leak `PAPERCLIP_*` values as missing or `None`

## Install inside the Paperclip workspace

The adapter is vendored as a workspace package:

```text
packages/adapters/hermes-local
```

Paperclip consumes it from the server and UI workspaces, so a normal workspace install is enough:

```bash
PATH="$HOME/.hermes/node/bin:$PATH" pnpm install
```

Hermes itself must already be installed and available on `PATH` as `hermes`.

## Recommended local prerequisites

- `hermes --version` succeeds
- `~/.hermes/config.yaml` contains the models you expect to expose in Paperclip
- any provider credentials Hermes needs are already configured
- for custom endpoints such as LiteLLM, prefer a dedicated Hermes home/profile and point the agent at it with `HERMES_HOME`

## Validation checklist

The integration has been validated with:

1. adapter unit tests:
   ```bash
   cd packages/adapters/hermes-local
   node --test tests/*.test.js
   ```
   When the local Hermes source checkout is available, this also runs the
   source-backed parser audit in `tests/parse-source-audit.test.js`.
2. focused Paperclip server tests:
   ```bash
   PATH="$HOME/.hermes/node/bin:$PATH" pnpm exec vitest run \
     server/src/__tests__/adapter-registry.test.ts \
     server/src/__tests__/adapter-session-codecs.test.ts \
     server/src/__tests__/adapter-models.test.ts \
     server/src/__tests__/approval-routes-idempotency.test.ts \
     server/src/__tests__/issue-assignment-wakeup.test.ts
   ```
3. browser automation:
   ```bash
   PATH="$HOME/.hermes/node/bin:$PATH" \
   PAPERCLIP_E2E_PORT=3200 \
   PAPERCLIP_E2E_HOME=.paperclip-local/e2e-home-hermes \
   pnpm exec playwright test \
     --config tests/e2e/playwright.config.ts \
     tests/e2e/hermes-onboarding-hiring.spec.ts
   ```
4. hierarchy + skills automation:
   ```bash
   PATH="$HOME/.hermes/node/bin:$PATH" \
   PAPERCLIP_E2E_PORT=3202 \
   PAPERCLIP_E2E_HOME=.paperclip-local/e2e-home-hermes-hierarchy \
   PAPERCLIP_E2E_HERMES_MODEL=gpt-4o \
   pnpm exec playwright test \
     --config tests/e2e/playwright.config.ts \
     tests/e2e/hermes-hierarchy-skills.spec.ts
   ```
5. approval lifecycle automation:
   ```bash
   PATH="$HOME/.hermes/node/bin:$PATH" \
   PAPERCLIP_E2E_PORT=3203 \
   PAPERCLIP_E2E_HOME=.paperclip-local/e2e-home-hermes-approvals \
   PAPERCLIP_E2E_HERMES_MODEL=gpt-4o \
   pnpm exec playwright test \
     --config tests/e2e/playwright.config.ts \
     tests/e2e/hermes-approval-lifecycle.spec.ts
   ```
6. direct Hermes-native smoke:
   ```bash
   packages/adapters/hermes-local/tests/hermes-native-smoke.sh
   ```

## Browser flow covered by automation

- create a company
- select a Hermes model from the live model list
- create a CEO using Hermes
- confirm the CEO can run
- have the CEO request a hire
- approve that hire as the board
- verify the approval wake reuses the approved manager instead of submitting a duplicate hire
- verify the worker agent is created
- assign the worker a task and verify it completes the task
- import a Paperclip-managed skill from GitHub and sync it into a hired Hermes agent
- verify a hired manager can use that imported skill
- verify the manager can hire a worker, wait for board approval, and delegate a child issue
- verify the worker can use a native Hermes skill from `~/.hermes/skills`
- verify a hired agent can author a brand new native Hermes skill and then use it in the same company workflow
- verify the reporting chain is preserved (`worker -> manager -> CEO`)
- verify recoverable Paperclip env placeholders in Hermes hire payloads are normalized host-side instead of failing the workflow
- verify loaded Hermes skills cannot replace the required Paperclip issue-comment and status-update workflow

The direct Hermes-native smoke script covers the operator-side paths that sit
adjacent to Paperclip:

- install a hub skill into an isolated `HERMES_HOME`
- use that installed skill in a real Hermes CLI run
- create and trigger a cron job
- verify the saved cron output artifact

## Skills: the two supported modes

### Paperclip-managed skills

These are skills imported into a Paperclip company and then synced to Hermes through:

- `POST /api/companies/:companyId/skills/import`
- `POST /api/agents/:id/skills/sync`

For Hermes, Paperclip materializes those runtime/company skills into the resolved Hermes home so they behave like real Hermes skills.

### Native Hermes skills

These are skills Hermes already has under:

```text
~/.hermes/skills
```

The adapter keeps them visible and does not overwrite them. If a Paperclip-managed skill wants the same friendly runtime name, the adapter falls back to a hashed runtime install name instead of clobbering the native skill.

## Scheduling / cron

Hermes scheduling is Hermes-native.

- Paperclip does not need custom scheduler plumbing for Hermes cron jobs.
- Hermes automatic scheduled execution depends on the Hermes gateway/service being installed and running.
- The `cronjob` toolset can be exposed to Hermes child runs, but background firing is owned by Hermes, not by Paperclip heartbeat logic.
- Paperclip sets `HERMES_EXEC_ASK=1` for Hermes child runs so Hermes exposes cron tooling in non-interactive agent sessions.

In practice this means:

1. Paperclip can launch Hermes with cron-capable toolsets.
2. Hermes cron jobs only fire automatically when `hermes gateway` (or the installed service) is running.
3. If the gateway is down, the adapter is still fine for normal issue work, but scheduled jobs will not execute in the background.

## Troubleshooting notes

- If the model list does not show Hermes-configured entries, confirm `server/src/adapters/registry.ts` is using `listModels()` rather than relying on static metadata.
- If a hired worker wakes up but asks for the task again, inspect the issue wake context and confirm it includes issue title/body fields.
- If a hired manager tries `POST /api/issues`, update or inspect the rendered prompt and confirm it shows the company-scoped issue route `POST /api/companies/{companyId}/issues`.
- If a run tries `POST /api/issues/None/comments` or `PATCH /api/issues/None`, inspect the prompt/skills and confirm the agent used terminal + `curl` rather than `execute_code` for the Paperclip mutation path.
- Hermes-native skills can tell the agent to "report", "wait", or ask for feedback. In Paperclip child runs that language must be treated as a checkpoint inside the task, not as permission to skip the required issue comment and final status PATCH.
- If an issue explicitly says to wait for board approval or review feedback, Hermes should stop after the progress comment and leave the issue open until the approval/review wake arrives.
- Approval comments canonically use `{ "body": "..." }`. The server now also tolerates `content` and `comments` for compatibility with agent-generated requests.
- Issue creation canonically uses `description`. The server also normalizes `body` on create for compatibility with agent-generated payloads.
- For LiteLLM or other custom OpenAI-compatible endpoints, configure Hermes with a dedicated `HERMES_HOME` whose `config.yaml` sets `model.provider: custom`, `model.base_url`, and the model id you want to run.
- For a summary of Paperclip-core changes that live outside the adapter package, see `docs/adapters/hermes-local-mainstream-deviations.md`.
