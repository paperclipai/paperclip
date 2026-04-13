# Phase 1: Frontend QA Agent + URL Verification — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship a complete vertical slice — one new QA agent, one runner, one on-demand endpoint — working against DLD-2793 as the smoke test. No gates wired yet. Phase 1 proves the vertical; Phase 2+ wires it into the state machine.

**Architecture:** New Frontend QA Agent in Paperclip. New `acceptance-viracue` skill containing the Viracue Playwright config, login helpers, and per-issue specs. New verification worker in `server/src/services/verification/` that SSHes to the browser-test VPS, runs Playwright against a deploy-SHA-verified URL, uploads the trace as evidence. Board-only on-demand endpoint for manual testing.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL, Playwright (remote), SSH via child_process, Vitest for tests.

**Reference:** [docs/plans/2026-04-13-verification-system-design-v2.md](./2026-04-13-verification-system-design-v2.md)

---

## Pre-flight checks

Before Task 1, verify codebase assumptions:

```bash
# Latest migration prefix
ls packages/db/src/migrations/ | tail -5
# Expect: 0050_*.sql most recent

# Browser-test VPS env vars
grep -rn BROWSER_TEST_HOST server/src packages/adapter-utils
# Expect: env var usage in adapters

# Skill directory structure
ls skills/ | head -20
# Expect: existing skills like paperclip/, dogfood/, playwright-expert/

# Current agents table schema
docker exec paperclip-db-1 psql -U paperclip paperclip -c "\d agents" | head -20
# Confirm adapter_config column is jsonb

# Existing QA Agent ID for later termination
docker exec paperclip-db-1 psql -U paperclip paperclip -c "SELECT id, name FROM agents WHERE name='QA Agent';"
# Expect: 24da232f-9ee1-435b-bf23-aa772ad5a981
```

If any assumption is wrong, STOP and flag to Damon. Do not improvise.

---

## Task 1: DB migration

**Files:**
- Create: `packages/db/src/migrations/0051_verification_system.sql`

**Step 1: Write migration**

```sql
-- 0051_verification_system.sql

-- Primary runs table
CREATE TABLE verification_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  deliverable_type TEXT NOT NULL,
  spec_path TEXT NOT NULL,
  context TEXT CHECK (context IN ('anonymous', 'authenticated') OR context IS NULL),
  target_sha TEXT,
  deployed_sha TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'passed', 'failed', 'unavailable', 'overridden')),
  trace_asset_id UUID REFERENCES assets(id),
  failure_summary TEXT,
  unavailable_reason TEXT,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER
);
CREATE INDEX verification_runs_issue_idx ON verification_runs(issue_id, started_at DESC);

-- Escalations (unused in Phase 1, created now)
CREATE TABLE verification_escalations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  verification_run_id UUID NOT NULL REFERENCES verification_runs(id),
  current_rung INTEGER NOT NULL DEFAULT 0,
  next_rung_at TIMESTAMPTZ NOT NULL,
  escalated_to_manager_at TIMESTAMPTZ,
  escalated_to_ceo_at TIMESTAMPTZ,
  escalated_to_board_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolution TEXT CHECK (resolution IN ('passed', 'overridden', 'reverted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX verification_escalations_open_idx ON verification_escalations(next_rung_at) WHERE resolved_at IS NULL;

-- Overrides (unused in Phase 1)
CREATE TABLE verification_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  verification_run_id UUID REFERENCES verification_runs(id),
  user_id TEXT NOT NULL,
  justification TEXT NOT NULL CHECK (length(justification) >= 20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Spec metadata for flake tracking (unused in Phase 1)
CREATE TABLE spec_metadata (
  spec_path TEXT PRIMARY KEY,
  total_runs INTEGER NOT NULL DEFAULT 0,
  pass_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  flake_count INTEGER NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  last_flake_at TIMESTAMPTZ,
  flaky BOOLEAN NOT NULL DEFAULT false,
  maintenance_issue_id UUID REFERENCES issues(id)
);

-- Chaos run log (unused in Phase 1)
CREATE TABLE verification_chaos_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario TEXT NOT NULL,
  expected_outcome TEXT NOT NULL,
  actual_outcome TEXT NOT NULL,
  passed BOOLEAN NOT NULL,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Columns on issues
ALTER TABLE issues
  ADD COLUMN deliverable_type TEXT,
  ADD COLUMN verification_target TEXT,
  ADD COLUMN verification_run_id UUID REFERENCES verification_runs(id),
  ADD COLUMN verification_status TEXT CHECK (verification_status IN ('pending', 'running', 'passed', 'failed', 'unavailable', 'overridden') OR verification_status IS NULL),
  ADD COLUMN multi_atomic BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN risk_high BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN incident_priority BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX issues_verification_status_idx ON issues(verification_status) WHERE verification_status IS NOT NULL;
```

**Step 2: Apply locally**

```bash
cd packages/db && pnpm drizzle-kit migrate
```
Expected: migration applies cleanly.

**Step 3: Verify**

```bash
docker exec paperclip-db-1 psql -U paperclip paperclip -c "\dt verification_*"
```
Expected: 4 tables listed (verification_runs, verification_escalations, verification_overrides, verification_chaos_runs) + spec_metadata.

**Step 4: Commit**

```bash
git add packages/db/src/migrations/0051_verification_system.sql
git commit -m "feat(db): add verification system tables

Phase 1 of server-side verification replacing honor-system QA gates.
See docs/plans/2026-04-13-verification-system-design-v2.md and DLD-2793."
```

---

## Task 2: Drizzle schemas

**Files:**
- Create: `packages/db/src/schema/verification.ts` (all 5 tables in one file — they're tightly coupled)
- Modify: `packages/db/src/schema/issues.ts` (add new columns)
- Modify: `packages/db/src/schema/index.ts` (re-export)
- Test: `packages/db/src/__tests__/verification-schemas.test.ts`

Follow the TDD pattern: write test asserting column names, run and fail, implement schema, run and pass, commit.

Schema follows the SQL from Task 1. Use `$type<>()` for TypeScript enum types on `status`, `context`, `resolution`.

Commit: `feat(db): add drizzle schemas for verification tables`

---

## Task 3: SSH runner helper

**Files:**
- Create: `server/src/services/verification/ssh-runner.ts`
- Test: `server/src/services/verification/__tests__/ssh-runner.test.ts`

Thin wrapper around `execFile('ssh', ...)` with timeout + mockable interface. Tests cover: correct argv construction, timeout handling, non-zero exit preservation.

Commit: `feat(server): add ssh-runner for browser-test VPS`

---

## Task 4: Build manifest fetcher

**Files:**
- Create: `server/src/services/verification/build-manifest.ts`
- Test: `server/src/services/verification/__tests__/build-manifest.test.ts`

```typescript
export interface BuildManifest {
  sha: string;
  deployedAt: string;
}

export async function fetchBuildManifest(baseUrl: string): Promise<BuildManifest> {
  const response = await fetch(`${baseUrl}/__build.json`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`build manifest fetch failed: ${response.status}`);
  }
  const data = await response.json();
  if (typeof data.sha !== 'string' || typeof data.deployedAt !== 'string') {
    throw new Error('build manifest missing required fields');
  }
  return { sha: data.sha, deployedAt: data.deployedAt };
}

export async function waitForSha(
  baseUrl: string,
  expectedSha: string,
  maxAttempts = 1,
  delayMs = 0,
): Promise<{ matched: boolean; deployedSha: string }> {
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, delayMs));
    const manifest = await fetchBuildManifest(baseUrl);
    if (manifest.sha === expectedSha) {
      return { matched: true, deployedSha: manifest.sha };
    }
  }
  const finalManifest = await fetchBuildManifest(baseUrl);
  return { matched: false, deployedSha: finalManifest.sha };
}
```

Tests: mock fetch, cover 200+valid, 200+missing fields, 404, timeout, SHA match, SHA mismatch.

Commit: `feat(server): add build manifest fetcher for deploy SHA verification`

---

## Task 5: Viracue build manifest endpoint

**This is a Viracue repo change, not a Paperclip change.**

**Files (Viracue repo):**
- Create: `viracue/scripts/write-build-manifest.mjs`
- Modify: `viracue/package.json` (add to build script)
- Modify: `viracue/vite.config.ts` or equivalent (ensure `public/__build.json` is served)

**Step 1: Write the script**

```javascript
// viracue/scripts/write-build-manifest.mjs
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const sha = process.env.VERCEL_GIT_COMMIT_SHA
  || process.env.GITHUB_SHA
  || execSync('git rev-parse HEAD').toString().trim();

const manifest = {
  sha,
  deployedAt: new Date().toISOString(),
};

mkdirSync(resolve('public'), { recursive: true });
writeFileSync(
  resolve('public/__build.json'),
  JSON.stringify(manifest, null, 2),
);
console.log(`wrote public/__build.json with sha ${sha}`);
```

**Step 2: Wire into build**

Modify `viracue/package.json`:
```json
{
  "scripts": {
    "build": "node scripts/write-build-manifest.mjs && vite build"
  }
}
```

**Step 3: Verify in a local build**

```bash
cd viracue && npm run build && cat dist/__build.json
```
Expected: `{"sha": "...", "deployedAt": "..."}`.

**Step 4: Open Viracue PR**

```bash
git checkout -b feat/build-manifest
git add scripts/write-build-manifest.mjs package.json
git commit -m "feat: expose build manifest at /__build.json for Paperclip verification worker"
gh pr create --title "feat: build manifest endpoint" --body "Required by Paperclip verification worker (DLD-2793 follow-up). Exposes commit SHA at /__build.json so the worker can confirm the deployed version matches the expected one before running acceptance tests."
```

**Step 5: Merge and deploy Viracue**

Wait for the merge + deploy, then verify:
```bash
curl -s https://viracue.ai/__build.json | jq
```
Expected: valid JSON with current SHA.

**Step 6: Commit back to Paperclip (reference only)**

No code change in Paperclip. Just note in the Phase 1 tracking issue that Viracue manifest is live.

---

## Task 6: Playwright runner

**Files:**
- Create: `server/src/services/verification/runners/playwright-runner.ts`
- Test: `server/src/services/verification/__tests__/playwright-runner.test.ts`

The runner:
1. Takes `{ specPath, context, targetUrl, targetSha }`
2. Fetches build manifest, returns `unavailable` if SHA mismatch
3. Builds the command to run on the VPS: `cd /tmp/paperclip-specs && npx playwright test <specPath> --project=<context> --reporter=json --trace=on`
4. The VPS must have the Paperclip repo cloned at `/tmp/paperclip-specs` with the current master branch (or the spec file SCP'd on demand — design decision below)
5. Runs the SSH command
6. Parses JSON reporter output
7. Returns `passed | failed | unavailable`

**Spec delivery to VPS:** Two options:
- **A)** Clone Paperclip repo on the VPS and `git pull` before each run. Simple, but adds ~5s per run and requires git on VPS (it has it).
- **B)** SCP the single spec file + `playwright.config.ts` + `helpers/` directory on each run. Faster, but more moving parts.

**Pick A for Phase 1** — simpler, acceptable latency.

Setup the VPS once:
```bash
ssh -i $BROWSER_TEST_SSH_KEY root@207.148.14.165 'cd /tmp && git clone https://github.com/Viraforge/paperclip.git paperclip-specs && cd paperclip-specs/skills/acceptance-viracue && npm install'
```

This is a manual one-time step in Phase 1. Phase 4 can automate it.

**Runner pseudocode:**

```typescript
export async function runPlaywrightSpec(input: RunPlaywrightInput): Promise<RunPlaywrightResult> {
  // 1. Verify deploy SHA matches
  const shaCheck = await waitForSha(input.targetUrl, input.targetSha);
  if (!shaCheck.matched) {
    return { status: 'unavailable', unavailableReason: `deploy_not_ready: expected ${input.targetSha}, got ${shaCheck.deployedSha}` };
  }

  // 2. Build SSH command
  const specRelPath = input.specPath; // relative to paperclip repo root
  const skillDir = specRelPath.split('/tests/')[0]; // e.g. "skills/acceptance-viracue"
  const command = [
    'cd /tmp/paperclip-specs',
    'git pull --quiet',
    `cd ${skillDir}`,
    `npx playwright test tests/${specRelPath.split('/tests/')[1]} --project=${input.context} --reporter=json --trace=on --output=/tmp/trace-${input.issueId}`,
  ].join(' && ');

  // 3. Run
  let sshResult;
  try {
    sshResult = await runSshCommand({
      host: process.env.BROWSER_TEST_HOST!,
      user: process.env.BROWSER_TEST_USER ?? 'root',
      keyPath: process.env.BROWSER_TEST_SSH_KEY!,
      command,
      timeoutMs: 180_000,
    });
  } catch (err) {
    return { status: 'unavailable', unavailableReason: err instanceof Error ? err.message : String(err) };
  }

  // 4. Parse JSON report from stdout (Playwright JSON reporter emits to stdout)
  let report;
  try {
    report = JSON.parse(sshResult.stdout);
  } catch {
    return { status: 'unavailable', unavailableReason: `failed to parse playwright output: ${sshResult.stderr.slice(0, 500)}` };
  }

  if (report.stats?.unexpected === 0 && report.stats?.expected > 0) {
    return { status: 'passed', traceDir: `/tmp/trace-${input.issueId}`, durationMs: report.stats?.duration ?? 0 };
  }

  const failureSummary = extractFirstFailure(report);
  return { status: 'failed', traceDir: `/tmp/trace-${input.issueId}`, failureSummary, durationMs: report.stats?.duration ?? 0 };
}
```

Tests mock `runSshCommand` and `fetchBuildManifest` to cover: SHA mismatch → unavailable, SSH error → unavailable, passed report, failed report, malformed JSON → unavailable.

Commit: `feat(server): add playwright runner with deploy SHA verification`

---

## Task 7: Trace uploader

**Files:**
- Create: `server/src/services/verification/trace-uploader.ts`
- Test: `server/src/services/verification/__tests__/trace-uploader.test.ts`

Steps:
1. SSH to VPS, tar the trace directory, stream it back via stdout
2. Save tar to a temp file in the Paperclip container
3. Call existing `createAsset` service (grep for it in `server/src/services/assets.ts` or similar) with the tar as a Buffer
4. Return the asset ID
5. Create the `issue_attachments` row linking the asset to the issue

Test mocks SSH + asset service, verifies correct call sequence.

Commit: `feat(server): add trace bundle uploader`

---

## Task 8: VerificationWorker orchestrator

**Files:**
- Create: `server/src/services/verification/verification-worker.ts`
- Test: `server/src/services/verification/__tests__/verification-worker.test.ts`

The orchestrator owns:
- Inserting `verification_runs` rows for each attempt
- Retry budget (3 attempts, 60s backoff)
- Dispatching to the correct runner (Phase 1: only `url` → `runPlaywrightSpec`)
- Calling trace uploader on both pass and fail (trace is evidence either way)
- Updating final run status

Tests cover:
- Stops on first pass (no extra runs)
- Exhausts retries on repeated fail
- Does NOT count unavailable against retries
- Correctly inserts one `verification_runs` row per attempt
- Returns correct shape for all three outcomes

Commit: `feat(server): add verification worker orchestrator with retry budget`

---

## Task 9: On-demand verify endpoint

**Files:**
- Create: `server/src/routes/verification.ts`
- Modify: `server/src/index.ts` (register route)
- Test: `server/src/__tests__/verification-route.test.ts`

```typescript
// POST /api/issues/:id/verify
// Board-only. Body: { specPath: string, context: 'anonymous'|'authenticated', targetSha: string, targetUrl: string }
// Returns: { status, traceAssetId?, failureSummary?, unavailableReason? }
```

Tests: 403 for agent actors, 200 for board, mocked worker result propagation.

Commit: `feat(server): add POST /api/issues/:id/verify board-only endpoint`

---

## Task 10: acceptance-viracue skill scaffold

**Files:**
- Create: `skills/acceptance-viracue/SKILL.md`
- Create: `skills/acceptance-viracue/playwright.config.ts`
- Create: `skills/acceptance-viracue/package.json`
- Create: `skills/acceptance-viracue/helpers/login-clerk.ts` (stub for Phase 4)
- Create: `skills/acceptance-viracue/tests/.gitkeep`

**SKILL.md content:**

```markdown
---
name: acceptance-viracue
description: Use this skill when authoring Playwright acceptance specs for Viracue.ai issues. Covers anonymous and authenticated (Clerk) contexts, build manifest awareness, and spec quality requirements.
---

# Viracue Acceptance Specs

## When to use

Use this skill when you are the Frontend QA agent assigned to write an acceptance spec for a Viracue issue (deliverable_type: url or lib_frontend).

## Where specs live

One spec file per issue at `tests/<ISSUE_IDENTIFIER>.<type>.spec.ts`:
- `tests/DLD-2793.url.spec.ts`
- `tests/DLD-1234.lib.spec.ts`

## Spec structure

Every spec MUST:
1. Contain at least 3 `expect()` calls (spec_quality gate enforces this)
2. Reference the deliverable target (URL, component name) from the issue's `verification_target` field
3. Run in the `anonymous` Playwright project by default (set to `authenticated` explicitly if login required)
4. Use `await expect(page).not.toHaveURL(/sign-?in/)` as a redirect check when testing public pages

## Auth contexts

- `anonymous`: clean cookieless Chromium (default)
- `authenticated`: uses storageState from a seeded Clerk test user (Phase 4 — not yet wired)

## Build manifest awareness

The verification worker confirms the deployed SHA matches before running your spec. You do not need to handle this in the spec itself — it's automatic.

## Reference example — DLD-2793

The tiktok demo incident spec lives at `tests/DLD-2793.url.spec.ts`. Study it for the canonical pattern: URL assertion + redirect-negative + content visibility + console error check.
```

**playwright.config.ts:**

```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  fullyParallel: false,
  reporter: 'json',
  use: {
    baseURL: 'https://viracue.ai',
    trace: 'on',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'anonymous',
      use: { ...devices['Desktop Chrome'], storageState: undefined },
    },
    {
      name: 'authenticated',
      use: { ...devices['Desktop Chrome'], storageState: '.auth/qa-user.json' },
    },
  ],
});
```

**package.json:**

```json
{
  "name": "acceptance-viracue",
  "private": true,
  "dependencies": {
    "@playwright/test": "^1.47.0"
  }
}
```

**helpers/login-clerk.ts (stub):**

```typescript
// Phase 4 — Clerk login helper for authenticated context
// TODO: implement storageState generation via Clerk login flow
export async function loginToClerk(/* ... */): Promise<void> {
  throw new Error('Clerk login helper not yet implemented — Phase 4');
}
```

Commit: `feat(skills): scaffold acceptance-viracue skill`

---

## Task 11: Create Frontend QA Agent

**Files:**
- No code — one SQL transaction via board script

**Step 1: Draft the agent config**

Frontend QA Agent needs:
- `adapter_type`: `claude_local`
- `adapter_config.instructionsFilePath`: `/paperclip/instances/default/agents/frontend-qa/AGENTS.md`
- `adapter_config.dangerouslySkipPermissions`: `true`
- `adapter_config.paperclipSkillSync.desiredSkills`: list of skill names (core 4 + discipline + acceptance-viracue)
- `capabilities` column: full instruction text
- `role`: `qa`
- `name`: `Frontend QA Agent`

**Step 2: Write instructions file**

Create `server/src/onboarding-assets/frontend-qa/AGENTS.md` with the Frontend QA agent's full operating instructions. Key sections:
- Identity and role
- 6-phase issue lifecycle (with emphasis on the QA's parts: phases 1, 5, and cross-review for high-risk)
- How to write Viracue specs (reference the acceptance-viracue skill)
- How to cross-review Backend QA specs
- Board override authority (none — must escalate)
- Forbidden actions (editing spec files in implementation review phase, self-approving, creating coaching issues for themselves)

**Step 3: Write HEARTBEAT.md**

Create `server/src/onboarding-assets/frontend-qa/HEARTBEAT.md` with heartbeat-specific guidance: what to check on every wakeup, how to pick up spec-authoring tasks, how to handle review requests.

**Step 4: Register in onboarding-asset-service**

Modify `server/src/services/onboarding-assets.ts` (or equivalent — grep for how `ceo` and `cto` are registered) to list `frontend-qa` as a known agent type.

**Step 5: Create the agent via board action**

Since the production server runs in authenticated mode, use the Paperclip API with a board token:

```bash
curl -X POST https://paperclip/api/companies/f6b6dbaa-8d6f-462a-bde7-3d277116b4fb/agents \
  -H "Authorization: Bearer $BOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d @frontend-qa-agent.json
```

Where `frontend-qa-agent.json` contains the adapter config, role, etc.

**Step 6: Verify**

```bash
docker exec paperclip-db-1 psql -U paperclip paperclip -c "SELECT id, name, role, status FROM agents WHERE name='Frontend QA Agent';"
```
Expected: one row, status `idle`.

Commit: `feat(onboarding): add Frontend QA agent instructions`

(The DB insert is not a commit — it's an operational action documented in a followup comment on the phase-1 tracking issue.)

---

## Task 12: Write DLD-2793 spec

**Files:**
- Create: `skills/acceptance-viracue/tests/DLD-2793.url.spec.ts`

```typescript
import { test, expect } from '@playwright/test';

test.describe('DLD-2793: TikTok approval demo flow', () => {
  test('anonymous visitor reaches demo without being redirected to sign-in', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
    });

    await page.goto('https://viracue.ai/review/tiktok-demo');

    // 1. We land on the demo URL, not bounced to sign-in
    await expect(page).toHaveURL(/\/review\/tiktok-demo$/);
    await expect(page).not.toHaveURL(/sign-?in/);

    // 2. Demo-specific content is visible (the claim was "4-step demo flow")
    await expect(page.getByText(/tap to connect|approve|review video/i)).toBeVisible({ timeout: 5000 });

    // 3. No JavaScript errors on page load
    expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
```

Commit: `feat(acceptance): add DLD-2793 failing spec as phase 1 smoke test`

---

## Task 13: Smoke test end-to-end

**No code changes. Manual operational verification.**

**Step 1: Merge Phase 1 PR to master, wait for auto-deploy**

```bash
gh pr merge <PR_NUMBER> --squash
gh run watch --repo Viraforge/paperclip
```

**Step 2: Confirm Viracue manifest is deployed**

```bash
curl -s https://viracue.ai/__build.json | jq
```
Expected: valid JSON with a recent deployedAt.

**Step 3: Call the on-demand endpoint against DLD-2793**

```bash
VIRACUE_SHA=$(curl -s https://viracue.ai/__build.json | jq -r .sha)
curl -X POST https://paperclip/api/issues/$(DLD-2793-UUID)/verify \
  -H "Authorization: Bearer $BOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"specPath\": \"skills/acceptance-viracue/tests/DLD-2793.url.spec.ts\",
    \"context\": \"anonymous\",
    \"targetSha\": \"$VIRACUE_SHA\",
    \"targetUrl\": \"https://viracue.ai\"
  }"
```

**Expected result:**
```json
{
  "status": "failed",
  "traceAssetId": "<uuid>",
  "failureSummary": "...URL does not match /\\/review\\/tiktok-demo$/... OR ...redirected to sign-in..."
}
```

**Step 4: Verify trace bundle**

```bash
docker exec paperclip-db-1 psql -U paperclip paperclip -c "SELECT id, original_filename, byte_size FROM assets WHERE id = '<traceAssetId>';"
```
Expected: row exists, filename includes `trace`, byte_size > 0.

```bash
curl -sSL "https://paperclip/api/assets/<traceAssetId>/download" -o trace.zip
npx playwright show-trace trace.zip
```
Expected: Playwright trace viewer opens, shows the navigation to viracue.ai, the redirect to sign-in, and the failing assertion.

**Step 5: Document the smoke test result**

Post a comment on DLD-2793 (reopen via board if needed) with the verification result and trace link. This is the first concrete, re-executable proof that DLD-2793 was never actually delivered.

**Step 6: If smoke test fails (returns `passed` or `unavailable`)**

Do NOT proceed to Task 14. Investigate:
- `passed` → the worker is broken OR someone actually deployed the demo in the interim. Check Viracue git history.
- `unavailable` → SSH, Playwright install, or build manifest is broken. Read the `unavailableReason` carefully.

---

## Task 14: Self-code-review

**Files:**
- No code changes. Invoke the code-reviewer skill against the Phase 1 diff.

**Step 1: Collect the full Phase 1 diff**

```bash
git log --oneline master..HEAD  # or the merge commit range
git diff master..HEAD > /tmp/phase-1.diff
wc -l /tmp/phase-1.diff
```

**Step 2: Invoke the code-reviewer skill**

From this conversation (or a fresh session), invoke:

```
Use the superpowers:code-reviewer skill to review the Phase 1 changes for the verification system. Focus areas:
1. SSH command injection risk (spec_path, context are user-controlled)
2. Retry budget correctness (does unavailable really not count against retries?)
3. Trace upload buffer size limits (are we streaming or loading to memory?)
4. Board-only endpoint auth check (is there a bypass?)
5. Migration reversibility (can we rollback 0051 if needed?)
6. Test coverage for the happy path + each error mode

Diff is at /tmp/phase-1.diff.
```

**Step 3: Triage findings**

- High severity → fix in a follow-up PR before Phase 2 starts
- Medium severity → document as known issues in the Phase 2 plan, fix opportunistically
- Low severity / style → ignore unless pattern appears multiple times

**Step 4: Commit the fix PR (if any)**

Standard PR flow.

**Phase 1 is done when:** smoke test returns `failed` on DLD-2793 with a viewable trace bundle, AND the self-code-review has no open high-severity findings.

---

## Exit criteria for Phase 1

All must be true:

1. Migration 0051 applied on production DB
2. Frontend QA Agent exists in DB with `status: idle`
3. `acceptance-viracue` skill exists in Paperclip repo with DLD-2793 spec committed
4. Viracue `/__build.json` endpoint returns valid JSON
5. On-demand `POST /api/issues/:id/verify` endpoint works and returns a real failure result for DLD-2793
6. Playwright trace bundle is uploaded and viewable
7. All unit tests pass (`pnpm -r test`)
8. Self-code-review completed with no open high-severity findings

When exit criteria are met, STOP. Do NOT start Phase 2 in the same session — create a new session and load Phase 2's plan document.

---

## What Phase 1 does NOT do (intentional)

- No gates are wired. Agents still close issues the old way.
- No Backend QA Agent exists yet. Only the Frontend QA Agent is created.
- No automated spec authoring. The DLD-2793 spec is hand-written as a demonstration.
- No escalation. The escalation tables exist but have no code paths writing to them.
- No UI changes. The `/verification-failures` dashboard is Phase 4.
- No cleanup of old gates. The old QA Agent is still operational. Cleanup is Phase 5.
