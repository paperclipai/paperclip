# Server-side verification worker design

**Date:** 2026-04-12
**Author:** Damon + Claude (brainstorming session)
**Status:** Approved for implementation
**Scheduled review:** 2026-04-19 (one week post-launch)

## Problem

Paperclip's QA gates verify that *artifacts exist* (a screenshot was uploaded, a PR URL is well-formed, a `QA: PASS` comment was posted) but never *re-execute the claim*. A PNG named `tiktok-demo-initial.png` satisfies the screenshot evidence gate regardless of what it actually shows. The QA agent's PASS comment is self-attested with no independent verification.

**Reference incident: DLD-2793 (2026-04-10).** CEO claimed a demo was deployed to `https://viracue.ai/review/tiktok-demo`. QA Agent uploaded 3 screenshots and posted `QA: PASS — 100/100, 0 console errors`. CTO closed the issue `done`. Production bundle `/assets/index-C3Rave3s.js` contains zero references to `tiktok-demo`. The route was never deployed. The URL redirects anonymous visitors to sign-in. All three enforcement gates (delivery, QA PASS, screenshot evidence) fired and passed on a completely fake delivery.

**Root cause:** Gates are artifact-presence checks, not re-execution checks. The same LLM that fabricated the delivery also fabricated the evidence, and the gates had no way to tell the difference.

## Goal

Replace honor-system QA for URL/UI deliverables with a server-side verification worker that:
1. Fetches the live production URL from clean, controlled browser contexts
2. Runs a Playwright spec committed to the repo (written by QA before implementation starts)
3. Stores its own trace bundle as evidence-of-record (not the agent's uploaded PNG)
4. Hard-blocks `done` transition on failure
5. Escalates stuck failures on an SLA ladder so nothing stalls silently

## Non-goals (first cut)

- API endpoint verification (contract testing) — roadmap scope B
- CLI binary / library function verification — roadmap scope C
- Universal independent reviewer agent — roadmap scope C
- Named-persona credential matrix (free/trial/pro/admin) — deferred
- Verification of non-Viracue products (RTAA, Paperclip itself) — follow-up PRs after pattern proves out

## Design

### Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌───────────────────┐
│ PATCH /issues/:id│──▶│ assertVerification│──▶│ verificationWorker│
│ (agent transition)│   │  Passed (gate)   │     │  .runSpec()       │
└─────────────────┘     └──────────────────┘     └─────────┬─────────┘
                                                            │ SSH
                                                            ▼
                                              ┌────────────────────────┐
                                              │ browser-test VPS       │
                                              │ 207.148.14.165         │
                                              │ npx playwright test    │
                                              │ <spec> --project=...   │
                                              └────────┬───────────────┘
                                                       │ trace.zip
                                                       ▼
                                              ┌────────────────────────┐
                                              │ issue_attachments      │
                                              │ (trace = evidence)     │
                                              └────────────────────────┘
```

### Components

**1. Playwright spec convention**

- Location: `tests/acceptance/<ISSUE_IDENTIFIER>.spec.ts` in the target product repo (Viracue for first cut).
- Written by QA agent before implementation begins.
- Must declare its context via Playwright project config: `--project=anonymous` (default) or `--project=qa-user`.
- Example for DLD-2793:

```typescript
import { test, expect } from '@playwright/test';

test.describe('DLD-2793 TikTok approval demo', () => {
  test('anonymous visitor can reach demo without redirect', async ({ page }) => {
    await page.goto('https://viracue.ai/review/tiktok-demo');
    await expect(page).toHaveURL(/\/review\/tiktok-demo$/);
    await expect(page).not.toHaveURL(/sign-?in/);
    await expect(page.getByText('Tap to connect')).toBeVisible();
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    expect(errors).toEqual([]);
  });
});
```

**2. `spec_ready` transition gate**

New gate: agent cannot transition issue to `in_progress` until a spec file exists at `tests/acceptance/<identifier>.spec.ts` in the target repo on the issue's working branch. Checked via `git ls-tree` in the workspace. Board users bypass.

Activity log action: `issue.spec_ready_gate_blocked`.

**3. `verification-worker` service**

Lives in the same Paperclip server container (`/app/server/src/services/verification-worker.ts`). Exposes:

```typescript
interface VerificationWorker {
  runSpec(input: {
    issueId: string;
    specPath: string;
    context: 'anonymous' | 'authenticated';
    productKey: 'viracue';  // expands later
  }): Promise<VerificationResult>;
}

type VerificationResult =
  | { status: 'passed'; traceAssetId: string; durationMs: number }
  | { status: 'failed'; traceAssetId: string; failureSummary: string; durationMs: number }
  | { status: 'unavailable'; reason: string };
```

Implementation:
1. Inserts a `verification_runs` row (`status: running`)
2. SSHes to browser-test VPS using existing `BROWSER_TEST_HOST` / `BROWSER_TEST_SSH_KEY` env
3. Clones the target repo's spec file into a temp dir on the VPS (or syncs via git)
4. Runs `npx playwright test <spec> --project=<context> --reporter=json --trace=on` with 180s timeout
5. Captures trace bundle (`trace.zip`) from `test-results/`
6. Uploads trace as an `assets` row, links via `issue_attachments`
7. Updates `verification_runs` with final status
8. Returns result

**Authentication contexts:**
- `anonymous`: fresh Chromium context, no `storageState`
- `authenticated`: loads `storageState` from seeded QA test user. Credentials pulled from encrypted secrets (`viracue-qa-test-user-email`, `viracue-qa-test-user-password`), scoped via `secret_ref` to the verification-worker's synthetic agent ID only. The worker generates `storageState` on first run per day and caches it in a volume-mounted file.

**Retry budget:** 3 attempts, 60s backoff between attempts, all attempts against the same deploy SHA. Only the final attempt's result is authoritative. All attempts logged in `verification_runs`.

**4. `assertVerificationPassed` gate**

Fires on agent transition to `done`. Pseudocode:

```typescript
async function assertVerificationPassed(issueId, targetStatus, actor) {
  if (actor.type !== 'agent') return;  // board bypass
  if (targetStatus !== 'done') return;
  const issue = await getIssue(issueId);
  if (!issue.executionWorkspaceId) return;  // non-code issues bypass

  const latestRun = await getLatestVerificationRun(issueId);
  if (!latestRun || latestRun.status !== 'passed') {
    // Attempt verification inline (with retry budget)
    const result = await verificationWorker.runSpec({...});
    if (result.status === 'unavailable') {
      await logBypass(issueId, result.reason);
      await alertBoard('verification_unavailable_bypass', issueId);
      return;  // fail-open on infra outage; alert loudly
    }
    if (result.status === 'failed') {
      await openEscalation(issueId, result);
      throw new GateError('verification_failed', {
        gate: 'verification_passed',
        traceUrl: `/api/assets/${result.traceAssetId}`,
        failureSummary: result.failureSummary,
      });
    }
  }
}
```

**Gate ordering:** After `assertQAGate`, before `assertAgentCommentRequired`. It's the final gate on `done`.

**5. Escalation sweeper**

New method `escalateFailedVerifications()` in `server/src/services/heartbeat.ts`, wired into the existing 30s scheduler tick in `server/src/index.ts` alongside `sweepUnpickedAssignments()` and `detectDirectDbClosures()`.

Logic:
1. Select rows from `verification_escalations` where `resolved_at IS NULL AND next_rung_at <= now()`
2. For each, determine next rung based on current rung + issue priority
3. Post an @mention comment from a synthetic `verification-system` actor, tagging the next person in the ladder
4. Trigger wakeup on the tagged agent (`queueIssueAssignmentWakeup`)
5. Update `current_rung` and `next_rung_at`
6. Log activity (`issue.verification_escalated_to_manager` / `_to_ceo` / `_to_board`)

Escalation ladder (normal priority):
| Rung | Elapsed since fail | Action |
|---|---|---|
| 0 | T+0 | @assignee, status forced to `in_progress` |
| 1 | T+30 min | @manager (role-based: CTO for eng/devops, CMO for marketing, CPO for product, CEO fallback) |
| 2 | T+2 hr | @CEO |
| 3 | T+4 hr | board dashboard + Slack/Discord alert |
| 4+ | every +4 hr | repeat board alert until resolved |

Urgent priority: 10m / 30m / 1h. Low priority: 4h / 12h / 24h.

**Passing verification cancels the ladder:** when a later verification_run returns `passed`, the escalation row is marked `resolved_at = now()` and no further wakeups fire.

**6. `/verification-failures` dashboard page**

New UI route showing open escalations:
- Issue identifier + title
- Assignee + current manager-on-the-hook
- Current rung + time to next rung
- Link to Playwright trace viewer
- Link to board override action (justification required)

**7. Board override endpoint**

`POST /api/issues/:id/verification-override`
- Board users only (403 for agents)
- Body: `{ justification: string }` — required, min 20 chars
- Creates `verification_overrides` row, marks the current failed `verification_run` as `overridden`, marks escalation `resolved_at`
- Logs `issue.verification_override` with full justification in activity feed
- Allows the issue to transition to `done`

**8. Bypass sweeper extension**

Extend existing `detectDirectDbClosures()` in `heartbeat.ts` to also flag:
```sql
SELECT id FROM issues
WHERE execution_workspace_id IS NOT NULL
  AND status = 'done'
  AND verification_run_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM verification_overrides WHERE issue_id = issues.id)
  AND updated_at > NOW() - INTERVAL '60 minutes'
```
Any match logs `issue.verification_bypass_detected` and fires a board alert.

**9. Alert channel**

Reuse Slack/Discord webhook infrastructure (if not already present, add a `BOARD_ALERT_WEBHOOK_URL` env var). Events that fire alerts:
- `verification_unavailable_bypass` — worker unreachable, issue closed anyway
- `escalation_to_board` — rung 3 reached
- `verification_bypass_detected` — issue closed without a verification_run_id

### Data model changes

**New table: `verification_runs`**
```sql
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
```

**New table: `verification_escalations`**
```sql
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
  resolution TEXT CHECK (resolution IN ('passed', 'overridden', NULL)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX verification_escalations_open_idx ON verification_escalations(next_rung_at) WHERE resolved_at IS NULL;
```

**New table: `verification_overrides`**
```sql
CREATE TABLE verification_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  verification_run_id UUID REFERENCES verification_runs(id),
  user_id TEXT NOT NULL,
  justification TEXT NOT NULL CHECK (length(justification) >= 20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**New columns on `issues`:**
- `verification_run_id UUID` — latest verification run, for quick lookup
- `verification_status TEXT` — mirrors latest run status for indexing/filtering

**Migration number:** next in sequence after `0050_process_lost_retry_at`.

### Error handling

- **Worker unreachable (SSH timeout, VPS down):** return `unavailable`, log `verification_unavailable_bypass`, board alert, do NOT block. Fail-open on infra, fail-loud on reporting.
- **Spec file missing on branch:** `spec_ready` gate blocks earlier; if somehow reached at `done` transition, return `failed` with summary "spec file not found".
- **Playwright returns non-zero but no trace:** upload stdout+stderr as trace fallback, mark `failed`.
- **Retry budget exhausted:** only the final attempt is authoritative. All intermediate attempts stored for debugging.
- **Concurrent verification runs for same issue:** serialize per-issue via `verification_runs` `running` status check; newer request waits or returns existing in-progress run.

### Testing strategy

**Unit tests** (`server/src/__tests__/verification-worker.test.ts`):
- Retry budget exhaustion
- Infra outage fail-open behavior
- Trace upload path
- Gate blocks on failed verification
- Gate bypasses for board users

**Unit tests** (`server/src/__tests__/verification-escalation-sweeper.test.ts`):
- Rung progression on timer expiry
- Resolution on passing verification
- Priority-based SLA (urgent/normal/low)
- Manager role resolution by assignee role

**Integration tests** (`server/src/__tests__/verification-gate-integration.test.ts`):
- Full flow: create issue → spec_ready gate → in_progress → done gate → verification run → pass
- Fail flow: verification fail → escalation opened → rung advance on sweeper tick

**E2E smoke test** (post-deploy):
- Create a test issue with a known-passing spec against viracue.ai
- Verify it transitions to done without issue
- Create a test issue with a known-failing spec
- Verify the gate blocks, escalation opens, trace is uploaded

### Rollout plan

1. **Phase 1 (PR 1):** DB migrations + `verification_runs` + `verification_worker.ts` + unit tests. No gate wired yet. Worker runs on-demand only.
2. **Phase 2 (PR 2):** `spec_ready` gate + `assertVerificationPassed` gate + escalation sweeper + escalations table. Gate in *log-only* mode (warn but don't block) for 24 hours on Viracue-only issues.
3. **Phase 3 (PR 3):** Gate enforcement enabled. Bypass sweeper extension. Board alert wiring. `/verification-failures` dashboard.
4. **Phase 4 (PR 4):** Seeded QA test user creation in Clerk + authenticated context support.
5. **Post-launch:** Monitor for 1 week, review 2026-04-19.

### Success criteria (evaluated 2026-04-19)

- **Zero faked deliveries slip through** (the primary goal — measured by Damon's manual catches dropping to zero)
- **<5% flake rate** on verification runs (measured from `verification_runs` retry stats)
- **<1% `verification_unavailable`** rate (worker uptime)
- **≤3 board overrides per week** (indicator that specs are reasonable)
- **Zero `verification_bypass_detected`** events (no agents gaming the system)
- **SLA calibration:** fewer than 2 `escalation_to_board` events per day on normal-priority issues

### Open questions for the 2026-04-19 review

1. Did the 30m/2h/4h ladder match real-world fix times, or does it need retuning?
2. Which issue classes did we miss because they weren't URL deliverables? (Inform scope B roadmap.)
3. Are Playwright specs actually being written by QA first, or are engineers writing both halves? (The independence rule is the whole point.)
4. Did agents try to DoS or game the retry budget?
5. Is the same-container worker causing memory/CPU issues, or do we need to split to a sidecar?

## Files to create/modify

**New files:**
- `server/src/services/verification-worker.ts`
- `server/src/services/verification-escalation.ts`
- `server/src/routes/verification-overrides.ts`
- `packages/db/src/schema/verification-runs.ts`
- `packages/db/src/schema/verification-escalations.ts`
- `packages/db/src/schema/verification-overrides.ts`
- `packages/db/src/migrations/0051_verification_system.sql`
- `server/src/__tests__/verification-worker.test.ts`
- `server/src/__tests__/verification-escalation-sweeper.test.ts`
- `server/src/__tests__/verification-gate-integration.test.ts`
- `ui/src/pages/VerificationFailures.tsx`
- `ui/src/components/VerificationEscalationCard.tsx`

**Modified files:**
- `server/src/routes/issues.ts` — add `assertVerificationPassed` and `assertSpecReady` gates, wire into PATCH handler
- `server/src/services/heartbeat.ts` — add `escalateFailedVerifications()`, extend `detectDirectDbClosures()`
- `server/src/index.ts` — wire new sweeper into scheduler tick
- `server/src/onboarding-assets/default/AGENTS.md` — document new QA workflow (spec-first)
- `skills/paperclip/SKILL.md` — document verification_runs API endpoints
- `CLAUDE.md` — document verification worker configuration, escalation ladder, board override procedure
- `ui/src/App.tsx` or router — add `/verification-failures` route

**Config / env:**
- `BOARD_ALERT_WEBHOOK_URL` — Slack or Discord webhook for board alerts
- `VERIFICATION_WORKER_ENABLED` — feature flag for gate enforcement (start `false`, flip to `true` after log-only phase)
- Seeded user secrets: `viracue-qa-test-user-email`, `viracue-qa-test-user-password`

## Review

**Approved:** 2026-04-12 (Damon via brainstorming session)
**Scheduled revisit:** 2026-04-19
