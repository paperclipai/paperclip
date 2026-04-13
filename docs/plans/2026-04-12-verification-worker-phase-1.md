# Verification Worker — Phase 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the foundation for server-side verification of URL deliverables — database schema, Playwright-based worker that SSHes to the browser-test VPS, and unit tests. No gates wired yet; the worker runs on-demand only. Phases 2-4 will wire gates, escalation, UI, and seeded test users in follow-up plans.

**Architecture:** A new service `verificationWorker` lives in the Paperclip server container, SSHes to the existing browser-test VPS (207.148.14.165), runs `npx playwright test <spec>` against production URLs in a clean Chromium context, captures the Playwright trace bundle, and stores it as an `issue_attachments` row. All state persists in three new tables (`verification_runs`, `verification_escalations`, `verification_overrides`). Phase 1 only exercises `verification_runs` — the escalation/override tables are created but unused.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL, Node child_process (SSH), Playwright (on remote VPS), Vitest for tests.

**Reference design doc:** [docs/plans/2026-04-12-verification-worker-design.md](./2026-04-12-verification-worker-design.md)

**Reference incident:** DLD-2793 — the failure mode this system exists to prevent.

---

## Pre-flight

Before starting Task 1, the executor must verify these assumptions about the codebase:

1. Latest migration file in `packages/db/src/migrations/` has prefix `0050_` (per CLAUDE.md — confirm with `ls packages/db/src/migrations/ | tail -5`).
2. Existing schema files live in `packages/db/src/schema/*.ts` and are re-exported from an index.
3. `server/src/services/heartbeat.ts` exists and contains `detectDirectDbClosures()` and other sweeper methods.
4. The browser-test VPS env vars (`BROWSER_TEST_HOST`, `BROWSER_TEST_USER`, `BROWSER_TEST_SSH_KEY`) are defined in the server container — confirm with `grep -r BROWSER_TEST_HOST server/src packages/`.
5. The test runner is Vitest — confirm with `cat server/package.json | grep -A2 '"scripts"'`.

If any of these are wrong, STOP and flag to Damon before proceeding — the plan needs adjustment.

---

## Task 1: DB migration for verification tables

**Files:**
- Create: `packages/db/src/migrations/0051_verification_system.sql`

**Step 1: Write the migration file**

```sql
-- 0051_verification_system.sql

CREATE TABLE verification_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  spec_path TEXT NOT NULL,
  context TEXT NOT NULL CHECK (context IN ('anonymous', 'authenticated')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'passed', 'failed', 'unavailable', 'overridden')),
  trace_asset_id UUID REFERENCES assets(id),
  failure_summary TEXT,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER
);
CREATE INDEX verification_runs_issue_idx ON verification_runs(issue_id, started_at DESC);

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
  resolution TEXT CHECK (resolution IN ('passed', 'overridden')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX verification_escalations_open_idx ON verification_escalations(next_rung_at) WHERE resolved_at IS NULL;

CREATE TABLE verification_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  verification_run_id UUID REFERENCES verification_runs(id),
  user_id TEXT NOT NULL,
  justification TEXT NOT NULL CHECK (length(justification) >= 20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE issues
  ADD COLUMN verification_run_id UUID REFERENCES verification_runs(id),
  ADD COLUMN verification_status TEXT CHECK (verification_status IN ('pending', 'running', 'passed', 'failed', 'unavailable', 'overridden'));

CREATE INDEX issues_verification_status_idx ON issues(verification_status) WHERE verification_status IS NOT NULL;
```

**Step 2: Run the migration in a local PG test instance**

Run: `cd packages/db && pnpm drizzle-kit migrate --config=drizzle.config.ts` (or whatever the existing migration command is — check `packages/db/package.json` scripts).

Expected: Migration applies cleanly, no errors.

**Step 3: Verify tables exist**

Run: `psql $DATABASE_URL -c "\dt verification_*"`
Expected: Three tables listed (`verification_runs`, `verification_escalations`, `verification_overrides`).

**Step 4: Commit**

```bash
git add packages/db/src/migrations/0051_verification_system.sql
git commit -m "feat(db): add verification_runs/escalations/overrides tables

Phase 1 of verification worker system. Tables support the Playwright-based
server-side QA verification that replaces honor-system gates (see
docs/plans/2026-04-12-verification-worker-design.md and DLD-2793 incident).

Phase 1 only exercises verification_runs; escalations/overrides tables are
created now so phase 2 can wire the sweeper without another migration."
```

---

## Task 2: Drizzle schema for verification_runs

**Files:**
- Create: `packages/db/src/schema/verification-runs.ts`
- Modify: `packages/db/src/schema/index.ts` (add export)
- Test: `packages/db/src/__tests__/verification-runs.schema.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/db/src/__tests__/verification-runs.schema.test.ts
import { describe, it, expect } from 'vitest';
import { verificationRuns } from '../schema/verification-runs';

describe('verificationRuns schema', () => {
  it('exports a drizzle table with expected columns', () => {
    const cols = Object.keys(verificationRuns);
    expect(cols).toContain('id');
    expect(cols).toContain('issueId');
    expect(cols).toContain('specPath');
    expect(cols).toContain('context');
    expect(cols).toContain('status');
    expect(cols).toContain('traceAssetId');
    expect(cols).toContain('failureSummary');
    expect(cols).toContain('attemptNumber');
    expect(cols).toContain('startedAt');
    expect(cols).toContain('completedAt');
    expect(cols).toContain('durationMs');
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `pnpm --filter @paperclipai/db test verification-runs.schema`
Expected: FAIL — `Cannot find module '../schema/verification-runs'`.

**Step 3: Write the schema file**

```typescript
// packages/db/src/schema/verification-runs.ts
import { pgTable, uuid, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { issues } from './issues';
import { assets } from './assets';

export const verificationRuns = pgTable(
  'verification_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    issueId: uuid('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
    specPath: text('spec_path').notNull(),
    context: text('context').notNull().$type<'anonymous' | 'authenticated'>(),
    status: text('status').notNull().$type<'pending' | 'running' | 'passed' | 'failed' | 'unavailable' | 'overridden'>(),
    traceAssetId: uuid('trace_asset_id').references(() => assets.id),
    failureSummary: text('failure_summary'),
    attemptNumber: integer('attempt_number').notNull().default(1),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
  },
  (t) => ({
    issueIdx: index('verification_runs_issue_idx').on(t.issueId, t.startedAt),
  }),
);

export type VerificationRun = typeof verificationRuns.$inferSelect;
export type NewVerificationRun = typeof verificationRuns.$inferInsert;
```

**Step 4: Re-export from schema index**

Add to `packages/db/src/schema/index.ts`:
```typescript
export * from './verification-runs';
```

**Step 5: Run the test to verify it passes**

Run: `pnpm --filter @paperclipai/db test verification-runs.schema`
Expected: PASS.

**Step 6: Commit**

```bash
git add packages/db/src/schema/verification-runs.ts packages/db/src/schema/index.ts packages/db/src/__tests__/verification-runs.schema.test.ts
git commit -m "feat(db): add verificationRuns drizzle schema"
```

---

## Task 3: Drizzle schemas for verification_escalations and verification_overrides

Same pattern as Task 2. Two schema files, one test file, one commit.

**Files:**
- Create: `packages/db/src/schema/verification-escalations.ts`
- Create: `packages/db/src/schema/verification-overrides.ts`
- Modify: `packages/db/src/schema/index.ts`
- Test: `packages/db/src/__tests__/verification-escalations.schema.test.ts`
- Test: `packages/db/src/__tests__/verification-overrides.schema.test.ts`

Column mapping is 1:1 with the SQL in Task 1. The `resolution` column on `verification_escalations` should be typed as `'passed' | 'overridden' | null`.

Commit message: `feat(db): add verificationEscalations and verificationOverrides schemas`

---

## Task 4: Add verification_run_id and verification_status to issues schema

**Files:**
- Modify: `packages/db/src/schema/issues.ts`

**Step 1: Locate issues schema**

Run: `grep -n 'export const issues = pgTable' packages/db/src/schema/issues.ts`
Expected: Returns line number of the table definition.

**Step 2: Add new columns at the end of the column list (before the index config callback)**

```typescript
verificationRunId: uuid('verification_run_id'),  // FK added in a later step to avoid circular import
verificationStatus: text('verification_status').$type<'pending' | 'running' | 'passed' | 'failed' | 'unavailable' | 'overridden'>(),
```

Note: intentionally no `.references()` here because `verification_runs` itself references `issues` — drizzle handles this FK at the SQL layer via the migration, not via the schema object.

**Step 3: Run existing issue tests to verify no regressions**

Run: `pnpm --filter @paperclipai/db test issues`
Expected: All existing tests PASS.

**Step 4: Commit**

```bash
git commit -m "feat(db): add verification_run_id and verification_status to issues"
```

---

## Task 5: SSH helper for the browser-test VPS

**Files:**
- Create: `server/src/services/verification/ssh-runner.ts`
- Test: `server/src/services/verification/__tests__/ssh-runner.test.ts`

The SSH helper is a thin wrapper around `child_process.execFile('ssh', ...)` that runs one command on the browser-test VPS and returns stdout/stderr/exit code. Kept separate so it can be mocked in tests.

**Step 1: Write the failing test**

```typescript
// server/src/services/verification/__tests__/ssh-runner.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runSshCommand } from '../ssh-runner';

describe('runSshCommand', () => {
  it('builds the correct ssh argv from env', async () => {
    const mockExecFile = vi.fn((cmd, args, opts, cb) => {
      cb(null, 'stdout-content', 'stderr-content');
    });
    const result = await runSshCommand({
      host: 'test.host',
      user: 'root',
      keyPath: '/tmp/key',
      command: 'echo hello',
      timeoutMs: 5000,
      execFile: mockExecFile as any,
    });
    expect(result.stdout).toBe('stdout-content');
    expect(result.exitCode).toBe(0);
    expect(mockExecFile).toHaveBeenCalledWith(
      'ssh',
      expect.arrayContaining(['-i', '/tmp/key', '-o', 'StrictHostKeyChecking=no', 'root@test.host', 'echo hello']),
      expect.objectContaining({ timeout: 5000 }),
      expect.any(Function),
    );
  });

  it('throws a TimeoutError on ssh timeout', async () => {
    const mockExecFile = vi.fn((cmd, args, opts, cb) => {
      const err: any = new Error('timeout');
      err.killed = true;
      err.signal = 'SIGTERM';
      cb(err, '', '');
    });
    await expect(
      runSshCommand({
        host: 't', user: 'root', keyPath: '/k', command: 'true', timeoutMs: 100, execFile: mockExecFile as any,
      }),
    ).rejects.toThrow(/timeout/);
  });
});
```

**Step 2: Run to verify it fails**

Run: `pnpm --filter @paperclipai/server test ssh-runner`
Expected: FAIL — module not found.

**Step 3: Implement**

```typescript
// server/src/services/verification/ssh-runner.ts
import { execFile as execFileDefault } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';

export interface SshRunInput {
  host: string;
  user: string;
  keyPath: string;
  command: string;
  timeoutMs: number;
  execFile?: typeof execFileDefault;
}

export interface SshRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class SshTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`ssh command exceeded timeout of ${timeoutMs}ms`);
    this.name = 'SshTimeoutError';
  }
}

export function runSshCommand(input: SshRunInput): Promise<SshRunResult> {
  const execFile = input.execFile ?? execFileDefault;
  const args = [
    '-i', input.keyPath,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${Math.max(5, Math.floor(input.timeoutMs / 10000))}`,
    `${input.user}@${input.host}`,
    input.command,
  ];
  return new Promise((resolve, reject) => {
    execFile('ssh', args, { timeout: input.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = err as ExecFileException;
        if (e.killed || e.signal === 'SIGTERM') {
          reject(new SshTimeoutError(input.timeoutMs));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: e.code ?? 1 });
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: 0 });
    });
  });
}
```

**Step 4: Run to verify it passes**

Run: `pnpm --filter @paperclipai/server test ssh-runner`
Expected: Both tests PASS.

**Step 5: Commit**

```bash
git add server/src/services/verification/
git commit -m "feat(server): add ssh-runner helper for browser-test VPS"
```

---

## Task 6: Playwright runner — happy path

**Files:**
- Create: `server/src/services/verification/playwright-runner.ts`
- Test: `server/src/services/verification/__tests__/playwright-runner.test.ts`

The Playwright runner takes a spec file path and a context name, constructs the right `npx playwright test` command, runs it on the remote VPS via `runSshCommand`, and parses the JSON reporter output to determine pass/fail.

**Step 1: Write the failing test (passed case)**

```typescript
// server/src/services/verification/__tests__/playwright-runner.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runPlaywrightSpec } from '../playwright-runner';

describe('runPlaywrightSpec', () => {
  it('returns passed when playwright reports 0 failures', async () => {
    const mockSsh = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0 },
        suites: [],
      }),
      stderr: '',
      exitCode: 0,
    });
    const result = await runPlaywrightSpec({
      specPath: 'tests/acceptance/DLD-1234.spec.ts',
      context: 'anonymous',
      repoDir: '/tmp/repo',
      ssh: mockSsh as any,
    });
    expect(result.status).toBe('passed');
    expect(result.failureSummary).toBeUndefined();
  });

  it('returns failed with summary when playwright reports failures', async () => {
    const mockSsh = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        stats: { expected: 0, unexpected: 1, skipped: 0, flaky: 0 },
        suites: [{
          specs: [{
            title: 'reaches demo without redirect',
            tests: [{ results: [{ status: 'failed', error: { message: 'expected URL /tiktok-demo, got /sign-in' } }] }],
          }],
        }],
      }),
      stderr: '',
      exitCode: 1,
    });
    const result = await runPlaywrightSpec({
      specPath: 'tests/acceptance/DLD-2793.spec.ts',
      context: 'anonymous',
      repoDir: '/tmp/repo',
      ssh: mockSsh as any,
    });
    expect(result.status).toBe('failed');
    expect(result.failureSummary).toContain('expected URL /tiktok-demo, got /sign-in');
  });

  it('returns unavailable when ssh throws', async () => {
    const mockSsh = vi.fn().mockRejectedValue(new Error('Connection refused'));
    const result = await runPlaywrightSpec({
      specPath: 'tests/acceptance/DLD-1.spec.ts',
      context: 'anonymous',
      repoDir: '/tmp/repo',
      ssh: mockSsh as any,
    });
    expect(result.status).toBe('unavailable');
    expect(result.unavailableReason).toContain('Connection refused');
  });
});
```

**Step 2: Run to verify failure**

Run: `pnpm --filter @paperclipai/server test playwright-runner`
Expected: FAIL — module not found.

**Step 3: Implement**

```typescript
// server/src/services/verification/playwright-runner.ts
import type { runSshCommand } from './ssh-runner';

export interface RunPlaywrightInput {
  specPath: string;
  context: 'anonymous' | 'authenticated';
  repoDir: string;
  ssh: typeof runSshCommand;
  timeoutMs?: number;
}

export type RunPlaywrightResult =
  | { status: 'passed'; traceDir: string; durationMs: number }
  | { status: 'failed'; traceDir: string; failureSummary: string; durationMs: number }
  | { status: 'unavailable'; unavailableReason: string };

interface PlaywrightJsonReport {
  stats: { expected: number; unexpected: number; skipped: number; flaky: number };
  suites: Array<{
    specs?: Array<{
      title: string;
      tests?: Array<{ results?: Array<{ status: string; error?: { message?: string } }> }>;
    }>;
  }>;
}

export async function runPlaywrightSpec(input: RunPlaywrightInput): Promise<RunPlaywrightResult> {
  const timeoutMs = input.timeoutMs ?? 180_000;
  const traceDir = `/tmp/playwright-${Date.now()}`;
  const command = [
    `cd ${input.repoDir}`,
    `PLAYWRIGHT_JSON_OUTPUT_NAME=${traceDir}/report.json`,
    `npx playwright test ${input.specPath}`,
    `--project=${input.context}`,
    `--reporter=json`,
    `--trace=on`,
    `--output=${traceDir}`,
  ].join(' && ');

  const started = Date.now();
  let sshResult;
  try {
    sshResult = await input.ssh({
      host: process.env.BROWSER_TEST_HOST ?? '',
      user: process.env.BROWSER_TEST_USER ?? 'root',
      keyPath: process.env.BROWSER_TEST_SSH_KEY ?? '',
      command,
      timeoutMs,
    });
  } catch (err) {
    return {
      status: 'unavailable',
      unavailableReason: err instanceof Error ? err.message : String(err),
    };
  }
  const durationMs = Date.now() - started;

  let report: PlaywrightJsonReport;
  try {
    report = JSON.parse(sshResult.stdout);
  } catch (err) {
    return {
      status: 'unavailable',
      unavailableReason: `failed to parse playwright JSON report: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (report.stats.unexpected === 0 && report.stats.expected > 0) {
    return { status: 'passed', traceDir, durationMs };
  }

  // Extract first failure message
  let failureSummary = 'unknown failure';
  for (const suite of report.suites) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          if (result.status !== 'passed' && result.error?.message) {
            failureSummary = `${spec.title}: ${result.error.message}`;
            break;
          }
        }
      }
    }
  }

  return { status: 'failed', traceDir, failureSummary, durationMs };
}
```

**Step 4: Run tests**

Run: `pnpm --filter @paperclipai/server test playwright-runner`
Expected: All 3 tests PASS.

**Step 5: Commit**

```bash
git commit -m "feat(server): add playwright runner for verification worker"
```

---

## Task 7: Trace bundle upload

**Files:**
- Create: `server/src/services/verification/trace-uploader.ts`
- Test: `server/src/services/verification/__tests__/trace-uploader.test.ts`

Takes the `traceDir` from the Playwright runner, SCPs or SSH-cats the trace.zip back to the server container, and uploads it as an `assets` row linked via `issue_attachments`. Uses the existing asset upload pipeline — grep for `createAsset` or similar in `server/src/services/` to find it.

**Step 1: Locate existing asset upload function**

Run: `grep -rn 'createAsset\|uploadAsset\|insertAsset' server/src/services/ | head -20`
Note the function signature — the trace uploader will call it.

**Step 2-5: TDD as above.** Write test that mocks the SSH + asset upload, verifies trace-uploader calls the right functions in the right order. Implement. Commit.

Commit message: `feat(server): add trace bundle uploader for verification runs`

---

## Task 8: VerificationWorker service (the orchestrator)

**Files:**
- Create: `server/src/services/verification/verification-worker.ts`
- Test: `server/src/services/verification/__tests__/verification-worker.test.ts`

The orchestrator. Takes a `{issueId, specPath, context}` input. Inserts a `verification_runs` row in `running` status. Calls the Playwright runner. On pass/fail, calls the trace uploader. Updates the row with final status + trace asset ID.

**Implements the retry budget:** 3 attempts, 60s backoff between attempts, stop on first `passed`. Each attempt gets its own `verification_runs` row with `attempt_number`. The final row's status is authoritative. Unit test the retry logic with a mock runner that fails 2x then passes.

**Step 1: Write the failing test (retry logic)**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { VerificationWorker } from '../verification-worker';

describe('VerificationWorker.runSpec', () => {
  it('stops retrying on first pass', async () => {
    const mockRunner = vi.fn()
      .mockResolvedValueOnce({ status: 'failed', traceDir: '/tmp/a', failureSummary: 'x', durationMs: 1000 })
      .mockResolvedValueOnce({ status: 'passed', traceDir: '/tmp/b', durationMs: 1000 });
    const worker = new VerificationWorker({
      runner: mockRunner,
      uploader: vi.fn().mockResolvedValue('asset-id'),
      db: mockDb(),
      retryBudget: 3,
      retryDelayMs: 0,  // no delay in tests
    });
    const result = await worker.runSpec({ issueId: 'i', specPath: 's', context: 'anonymous' });
    expect(result.status).toBe('passed');
    expect(mockRunner).toHaveBeenCalledTimes(2);
  });

  it('returns failed after exhausting retry budget', async () => { /* ... */ });
  it('returns unavailable without retrying when ssh errors', async () => { /* ... */ });
  it('inserts a verification_runs row per attempt', async () => { /* ... */ });
});
```

**Step 2-5: TDD.** Implement the class, run tests, commit.

**Important:** Do NOT wire this into any gate yet. Phase 1 is foundation-only. The gate wiring happens in Phase 2 after we've verified the worker is correct.

Commit message: `feat(server): add VerificationWorker orchestrator with retry budget`

---

## Task 9: On-demand API endpoint (for manual testing in production)

**Files:**
- Create: `server/src/routes/verification.ts`
- Modify: `server/src/index.ts` (register route)
- Test: `server/src/__tests__/verification-route.test.ts`

A single `POST /api/issues/:id/verify` endpoint. Board-only (403 for agents — enforced via existing middleware). Takes `{ specPath: string, context: 'anonymous' | 'authenticated' }`. Calls `VerificationWorker.runSpec()` inline. Returns the result including trace URL.

**Purpose:** Lets Damon manually trigger verification on any issue from the board UI or curl, as a smoke test while the gates are still disabled. Phase 2 removes the need for this by wiring the automatic gate.

**Step 1: Write the failing test.** Integration test that hits the route with a mocked worker and asserts the response shape + board-only access.

**Step 2-5: TDD.** Implement, wire into router, run tests, commit.

Commit message: `feat(server): add POST /api/issues/:id/verify board-only endpoint for phase 1 smoke testing`

---

## Task 10: Manual smoke test against DLD-2793

**Files:**
- No code changes.

**Step 1: Check out and build the branch locally**

```bash
pnpm install
pnpm --filter @paperclipai/db build
pnpm --filter @paperclipai/adapter-utils build
pnpm --filter @paperclipai/plugin-sdk build
pnpm --filter @paperclipai/server build
```

**Step 2: Deploy to the Paperclip VPS via the standard deploy workflow**

Merge the phase-1 PR to master. `deploy-vultr.yml` auto-triggers.

**Step 3: Write a failing spec for DLD-2793 and check it into the Viracue repo on a test branch**

```typescript
// viracue/tests/acceptance/DLD-2793.spec.ts
import { test, expect } from '@playwright/test';

test('anonymous visitor reaches tiktok demo without redirect', async ({ page }) => {
  await page.goto('https://viracue.ai/review/tiktok-demo');
  await expect(page).toHaveURL(/\/review\/tiktok-demo$/);
  await expect(page).not.toHaveURL(/sign-?in/);
  await expect(page.getByText(/tap to connect|approve|demo/i)).toBeVisible({ timeout: 5000 });
});
```

Commit and push to a Viracue branch. Do NOT merge — this spec SHOULD fail.

**Step 4: Call the on-demand endpoint against DLD-2793**

```bash
curl -X POST https://paperclip/api/issues/DLD-2793/verify \
  -H "Authorization: Bearer $BOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"specPath":"tests/acceptance/DLD-2793.spec.ts","context":"anonymous"}'
```

**Expected:** Returns `{ status: "failed", failureSummary: "... expected URL /tiktok-demo, got /sign-in ...", traceAssetId: "..." }`.

**If it returns `passed`:** The worker is broken (or someone fixed viracue.ai in the meantime). Investigate before proceeding to Phase 2.

**If it returns `unavailable`:** SSH, env vars, or Playwright install on the VPS is broken. Debug before proceeding.

**Step 5: Verify the trace asset was uploaded**

```bash
psql -c "SELECT id, original_filename, byte_size FROM assets WHERE id = '<traceAssetId>';"
```

Expected: Row exists, `original_filename` is `trace.zip` (or similar), `byte_size` > 0.

**Step 6: Document the smoke test result in the DLD-2793 issue**

Post a comment with the verification result and trace link. This is the first time Paperclip has a real, re-executable proof that DLD-2793 was never actually delivered.

---

## Exit criteria for Phase 1

Phase 1 is done when:

1. All 10 tasks are committed and the PR is merged to master.
2. The server container runs with the new tables (verified by `\dt verification_*` on the VPS DB).
3. The on-demand `POST /api/issues/:id/verify` endpoint returns a real failure result for DLD-2793 with an uploaded trace bundle.
4. Zero existing tests are broken by the changes (`pnpm -r test` passes).
5. Damon has verified the trace bundle is viewable (download via the asset endpoint, `npx playwright show-trace trace.zip`).

When exit criteria are met, STOP and write the Phase 2 plan. Do NOT proceed to gate wiring, escalation sweeper, or UI work in the same plan — those depend on Phase 1 being observably correct first.

---

## What Phase 2 will cover (preview, not to be implemented here)

- `assertSpecReady` gate on `in_progress` transition
- `assertVerificationPassed` gate on `done` transition (in log-only mode for first 24h)
- `escalateFailedVerifications()` sweeper method in `heartbeat.ts`
- Extension of `detectDirectDbClosures()` to catch verification bypasses
- `POST /api/issues/:id/verification-override` board endpoint
- Wiring `BOARD_ALERT_WEBHOOK_URL` env var and alert helper
- Integration tests for the full gate + sweeper flow

## What Phase 3 will cover

- `/verification-failures` dashboard UI page
- Escalation card component
- Trace viewer integration

## What Phase 4 will cover

- Seeded QA test user creation in Clerk (Viracue)
- `authenticated` context storageState generation + caching
- Encrypted secrets wiring for test user credentials
