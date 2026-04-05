---
title: Hermes Local
summary: Run Hermes Agent locally through Paperclip with dynamic model discovery and approval-aware wake handling
---

`hermes_local` runs [Hermes Agent](https://github.com/NousResearch/hermes-agent) through Paperclip's local adapter runtime.

## What this integration supports

- dynamic model discovery from `~/.hermes/config.yaml`
- durable session reuse across wakes
- Paperclip-aware prompts for tasks, comments, approvals, and hiring
- approval lifecycle wakeups for approve, reject, and revision-request flows
- subordinate hiring through Paperclip's board approval workflow

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

## Browser flow covered by automation

- create a company
- select a Hermes model from the live model list
- create a CEO using Hermes
- confirm the CEO can run
- have the CEO request a hire
- approve that hire as the board
- verify the worker agent is created
- assign the worker a task and verify it completes the task

## Troubleshooting notes

- If the model list does not show Hermes-configured entries, confirm `server/src/adapters/registry.ts` is using `listModels()` rather than relying on static metadata.
- If a hired worker wakes up but asks for the task again, inspect the issue wake context and confirm it includes issue title/body fields.
- Approval comments canonically use `{ "body": "..." }`. The server now also tolerates `content` and `comments` for compatibility with agent-generated requests.
- For LiteLLM or other custom OpenAI-compatible endpoints, configure Hermes with a dedicated `HERMES_HOME` whose `config.yaml` sets `model.provider: custom`, `model.base_url`, and the model id you want to run.
