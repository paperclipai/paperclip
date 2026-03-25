# GitHub Plugin Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a current-runtime-compatible GitHub integration plugin for Paperclip, shipping CI webhook failure ingestion first while preserving a clear path to the broader feature set modeled by the external GitHub Issues plugin.

**Architecture:** Create a new first-party plugin package under `packages/plugins/github-integration/` that follows the current Paperclip example-plugin structure. Reuse as much logic and module separation as possible from the existing GitHub plugin sources, but port all SDK interactions to the current `@paperclipai/plugin-sdk` contract and ship a built worker package that can be installed by local path.

**Tech Stack:** TypeScript, `@paperclipai/plugin-sdk`, Paperclip plugin host runtime, Vitest, GitHub webhook payloads, HMAC-SHA256 verification

---

### Task 1: Scaffold the new plugin package

**Files:**
- Create: `packages/plugins/github-integration/package.json`
- Create: `packages/plugins/github-integration/tsconfig.json`
- Create: `packages/plugins/github-integration/src/index.ts`
- Create: `packages/plugins/github-integration/src/constants.ts`
- Create: `packages/plugins/github-integration/src/manifest.ts`
- Modify: `pnpm-workspace.yaml` only if the new package path is not already included

**Step 1: Write the failing structural checks**

Create a small package-local smoke test:

- `packages/plugins/github-integration/src/package-smoke.test.ts`

Test expectations:

- plugin package metadata exists
- `paperclipPlugin.manifest` points at `./dist/manifest.js`
- `paperclipPlugin.worker` points at `./dist/worker.js`
- manifest imports compile

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm vitest run packages/plugins/github-integration/src/package-smoke.test.ts
```

Expected:

- FAIL because package files do not exist yet

**Step 3: Write minimal package skeleton**

Use `packages/plugins/examples/plugin-kitchen-sink-example/` as the structure model.

Required package choices:

- package name: `@paperclipai/plugin-github`
- module type: `module`
- scripts:
  - `build`
  - `clean`
  - `typecheck`
- dependencies:
  - `@paperclipai/plugin-sdk`
  - `@paperclipai/shared`

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm vitest run packages/plugins/github-integration/src/package-smoke.test.ts
pnpm --filter @paperclipai/plugin-github typecheck
```

Expected:

- PASS for smoke test
- typecheck passes for scaffold

**Step 5: Commit**

```bash
git add packages/plugins/github-integration pnpm-workspace.yaml
git commit -m "feat: scaffold github integration plugin"
```

### Task 2: Port the manifest and configuration model

**Files:**
- Modify: `packages/plugins/github-integration/src/constants.ts`
- Modify: `packages/plugins/github-integration/src/manifest.ts`
- Create: `packages/plugins/github-integration/src/config.ts`
- Test: `packages/plugins/github-integration/src/config.test.ts`

**Step 1: Write the failing tests**

Create `config.test.ts` to cover:

- required `webhookSecretRef` or plain `webhookSecret` development mode choice
- required `companyId`
- optional `defaultAssigneeAgentId`
- optional `goalId`
- optional `skipSignatureVerification`
- future-safe placeholders for issue-sync config, but do not require them yet

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm vitest run packages/plugins/github-integration/src/config.test.ts
```

Expected:

- FAIL because parser/validator does not exist

**Step 3: Implement config parsing and manifest**

Manifest requirements for first slice:

- `webhooks.receive`
- `issues.read`
- `issues.create`
- `issues.update`
- `issue.comments.read`
- `issue.comments.create`
- `agents.read`
- `agents.invoke`
- `plugin.state.read`
- `plugin.state.write`
- `secrets.read-ref`

Worker-only for v1:

- do not add UI entrypoint yet unless needed for current host
- rely on generated settings form from `instanceConfigSchema`

Schema should include:

- `webhookSecretRef`
- `companyId`
- `defaultAssigneeAgentId`
- `goalId`
- `skipSignatureVerification`
- reserve optional future issue-sync keys without implementing them yet

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm vitest run packages/plugins/github-integration/src/config.test.ts
pnpm --filter @paperclipai/plugin-github typecheck
```

Expected:

- PASS

**Step 5: Commit**

```bash
git add packages/plugins/github-integration/src/constants.ts packages/plugins/github-integration/src/manifest.ts packages/plugins/github-integration/src/config.ts packages/plugins/github-integration/src/config.test.ts
git commit -m "feat: add github plugin manifest and config model"
```

### Task 3: Port signature verification and event normalization

**Files:**
- Create: `packages/plugins/github-integration/src/github-types.ts`
- Create: `packages/plugins/github-integration/src/verify-signature.ts`
- Create: `packages/plugins/github-integration/src/normalize.ts`
- Test: `packages/plugins/github-integration/src/verify-signature.test.ts`
- Test: `packages/plugins/github-integration/src/normalize.test.ts`

**Step 1: Write the failing tests**

Verification tests:

- valid `X-Hub-Signature-256` passes
- invalid signature fails
- missing signature fails unless dev bypass enabled

Normalization tests:

- `workflow_run` failure payload maps to shared internal failure shape
- `check_run` failure payload maps to shared internal failure shape
- successful/non-terminal events return ignored/no-op result

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm vitest run packages/plugins/github-integration/src/verify-signature.test.ts packages/plugins/github-integration/src/normalize.test.ts
```

Expected:

- FAIL because modules do not exist yet

**Step 3: Port and adapt logic**

Reuse as much source logic as possible from:

- A2A Forge CI notify plugin for signature verification and CI payload handling
- `paperclip-plugin-github-issues` for GitHub type organization and module structure

Internal normalized shape should include:

- source event type
- external delivery id if present
- repository
- branch / SHA if available
- PR linkage metadata if available
- conclusion / status
- canonical title
- canonical summary/body payload for Paperclip issue/comment creation

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm vitest run packages/plugins/github-integration/src/verify-signature.test.ts packages/plugins/github-integration/src/normalize.test.ts
pnpm --filter @paperclipai/plugin-github typecheck
```

Expected:

- PASS

**Step 5: Commit**

```bash
git add packages/plugins/github-integration/src/github-types.ts packages/plugins/github-integration/src/verify-signature.ts packages/plugins/github-integration/src/normalize.ts packages/plugins/github-integration/src/verify-signature.test.ts packages/plugins/github-integration/src/normalize.test.ts
git commit -m "feat: add github webhook verification and normalization"
```

### Task 4: Implement dedupe and issue routing helpers

**Files:**
- Create: `packages/plugins/github-integration/src/dedupe.ts`
- Create: `packages/plugins/github-integration/src/routing.ts`
- Create: `packages/plugins/github-integration/src/issues.ts`
- Test: `packages/plugins/github-integration/src/dedupe.test.ts`
- Test: `packages/plugins/github-integration/src/routing.test.ts`

**Step 1: Write the failing tests**

Cover:

- duplicate delivery keys are detected via plugin state
- unknown author mapping falls back to default assignee
- missing default assignee leaves issue unassigned but still created
- routing helper preserves configured `goalId`

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm vitest run packages/plugins/github-integration/src/dedupe.test.ts packages/plugins/github-integration/src/routing.test.ts
```

Expected:

- FAIL because helpers do not exist yet

**Step 3: Implement helpers**

Dedupe strategy:

- use instance-scoped plugin state
- namespace by GitHub delivery id or derived composite key
- record enough metadata to debug repeated events

Issue behavior:

- first pass can create new issues for unmatched failures
- add comment path for future linked-issue updates
- keep formatting structured and deterministic

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm vitest run packages/plugins/github-integration/src/dedupe.test.ts packages/plugins/github-integration/src/routing.test.ts
pnpm --filter @paperclipai/plugin-github typecheck
```

Expected:

- PASS

**Step 5: Commit**

```bash
git add packages/plugins/github-integration/src/dedupe.ts packages/plugins/github-integration/src/routing.ts packages/plugins/github-integration/src/issues.ts packages/plugins/github-integration/src/dedupe.test.ts packages/plugins/github-integration/src/routing.test.ts
git commit -m "feat: add github plugin dedupe and routing helpers"
```

### Task 5: Implement the worker webhook flow

**Files:**
- Create: `packages/plugins/github-integration/src/worker.ts`
- Modify: `packages/plugins/github-integration/src/index.ts`
- Test: `packages/plugins/github-integration/src/worker.test.ts`

**Step 1: Write the failing tests**

Using the current SDK test harness or mocked `PluginContext`, cover:

- rejected invalid signature
- ignored successful/non-failure events
- successful failure ingestion creates a Paperclip issue
- duplicate delivery does not create a second issue
- fallback assignee routing works

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm vitest run packages/plugins/github-integration/src/worker.test.ts
```

Expected:

- FAIL because worker does not exist yet

**Step 3: Implement worker against the current SDK**

Follow current runtime shape from:

- `packages/plugins/sdk/README.md`
- `packages/plugins/examples/plugin-kitchen-sink-example/src/worker.ts`

Important current-runtime constraints:

- use `definePlugin({ setup, onWebhook, onValidateConfig })`
- do not use stale APIs from external repos without adaptation
- keep first slice worker-only

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm vitest run packages/plugins/github-integration/src/worker.test.ts
pnpm --filter @paperclipai/plugin-github build
```

Expected:

- PASS
- `dist/worker.js` and `dist/manifest.js` exist

**Step 5: Commit**

```bash
git add packages/plugins/github-integration/src/worker.ts packages/plugins/github-integration/src/index.ts packages/plugins/github-integration/src/worker.test.ts
git commit -m "feat: add github plugin webhook worker"
```

### Task 6: Validate local-path installation in Paperclip

**Files:**
- Modify: `packages/plugins/github-integration/README.md`
- Modify: optional host docs if install instructions need repo-local guidance

**Step 1: Write the failing validation step**

Run local-path install against a dev instance:

```bash
curl -sS -X POST "http://<paperclip-host>/api/plugins/install" \
  -H "Cookie: <board-session-cookie>" \
  -H "Origin: http://<paperclip-host>" \
  -H "Referer: http://<paperclip-host>/instance/settings/plugins" \
  -H "Content-Type: application/json" \
  -d '{"packageName":"<absolute-or-repo-local-path>","isLocalPath":true}'
```

Expected:

- install succeeds and returns plugin record

**Step 2: Run validation to verify the current failure mode**

Use the actual built path and confirm the plugin loads.

**Step 3: Add install docs**

Document:

- required build command
- local-path install command
- required config keys
- GitHub webhook setup for `workflow_run` and `check_run`

**Step 4: Re-run install to verify docs are accurate**

Expected:

- install succeeds using only the documented commands

**Step 5: Commit**

```bash
git add packages/plugins/github-integration/README.md
git commit -m "docs: add github plugin install instructions"
```

### Task 7: End-to-end CI notify verification

**Files:**
- Modify: `packages/plugins/github-integration/README.md`
- Modify: `doc/plans/2026-03-18-github-plugin-design.md` only if implementation materially changes design

**Step 1: Write the failing verification checklist**

Verification steps:

- plugin installed
- config saved
- GitHub webhook registered
- `workflow_run` failure delivery accepted
- `plugin_webhook_deliveries` shows success
- Paperclip issue/comment created or updated

**Step 2: Run live verification**

Use:

- board session auth
- trusted origin/referer headers for mutation routes
- live GitHub webhook delivery from `Viraforge/rtaa`

**Step 3: Fix the minimal issues found**

Keep changes tightly scoped to:

- payload normalization
- dedupe
- routing
- issue formatting

**Step 4: Re-run verification**

Expected:

- one successful webhook delivery row
- one correctly routed Paperclip artifact

**Step 5: Commit**

```bash
git add packages/plugins/github-integration packages/plugins/github-integration/README.md
git commit -m "feat: ship github plugin ci notify slice"
```

### Task 8: Port issue-sync features from the external GitHub plugin

**Files:**
- Create or modify as needed:
  - `packages/plugins/github-integration/src/github.ts`
  - `packages/plugins/github-integration/src/sync.ts`
  - `packages/plugins/github-integration/src/tools.ts`
  - `packages/plugins/github-integration/src/jobs.ts`
  - `packages/plugins/github-integration/src/events.ts`
- Test:
  - `packages/plugins/github-integration/src/sync.test.ts`
  - `packages/plugins/github-integration/src/tools.test.ts`

**Step 1: Write failing tests for one feature at a time**

Start with:

- GitHub issue search
- selective issue link creation
- one-way status sync

Do not implement comment mirroring and polling in the same first subtask.

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm vitest run packages/plugins/github-integration/src/sync.test.ts packages/plugins/github-integration/src/tools.test.ts
```

Expected:

- FAIL

**Step 3: Port incrementally from the external repo**

Reuse module boundaries and logic where still sound, but adapt:

- old context methods
- old event names
- old issue client method names
- old webhook assumptions

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm vitest run packages/plugins/github-integration/src/sync.test.ts packages/plugins/github-integration/src/tools.test.ts
pnpm --filter @paperclipai/plugin-github build
```

Expected:

- PASS

**Step 5: Commit**

```bash
git add packages/plugins/github-integration/src/github.ts packages/plugins/github-integration/src/sync.ts packages/plugins/github-integration/src/tools.ts packages/plugins/github-integration/src/jobs.ts packages/plugins/github-integration/src/events.ts packages/plugins/github-integration/src/sync.test.ts packages/plugins/github-integration/src/tools.test.ts
git commit -m "feat: port github issue sync features"
```

### Task 9: Full repo verification

**Files:**
- No intended file changes

**Step 1: Run package-local verification**

```bash
pnpm --filter @paperclipai/plugin-github typecheck
pnpm --filter @paperclipai/plugin-github build
pnpm vitest run packages/plugins/github-integration/src/*.test.ts
```

Expected:

- all plugin tests pass

**Step 2: Run repo-level verification required by this repo**

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

Expected:

- all pass, or any unrelated existing failures are documented clearly

**Step 3: Live install verification**

Reinstall or upgrade the plugin in a running Paperclip instance and confirm:

- status `ready`
- webhook delivery success
- issue artifact creation/update

**Step 4: Record evidence**

Capture:

- install output
- plugin config snapshot (without secrets)
- webhook delivery record
- created/updated Paperclip issue link

**Step 5: Commit**

```bash
git add .
git commit -m "test: verify github plugin end to end"
```
