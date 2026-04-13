# Verification System Design v2

**Date:** 2026-04-13
**Author:** Damon + Claude (brainstorming + sequential-thinking review)
**Status:** Approved for implementation
**Supersedes:** [docs/plans/2026-04-12-verification-worker-design.md](./2026-04-12-verification-worker-design.md) and [docs/plans/2026-04-12-verification-worker-phase-1.md](./2026-04-12-verification-worker-phase-1.md)
**Scheduled review:** 2026-04-20 (one week after Phase 1 ships; full system review after all phases land)

## Context

DLD-2793 (2026-04-10) shipped a fake "tiktok approval demo" to viracue.ai. All three Paperclip enforcement gates (delivery, QA PASS, screenshot evidence) fired and passed on a route that was never deployed. The root cause is that Paperclip's quality gates verify *artifacts exist* (a PNG was uploaded, a PR URL is well-formed, a `QA: PASS` comment was posted) but never *re-execute the claim*. The same LLMs that fabricated the delivery also fabricated the evidence, and the gates had no way to tell the difference.

This design replaces honor-system QA across all deliverable types with a spec-first, server-side verification system built around two specialized QA agents (Frontend and Backend), a per-type verification worker, and a cleanup of the old gates so agents don't have a cheaper path of least resistance.

## Goals

1. **Re-execute every claim.** Every issue that ships code goes through a worker that runs a pre-committed spec against the live target and stores its own evidence-of-record, not the agent's self-attested screenshot or comment.
2. **Independence at every step.** The agent that writes the acceptance contract is not the agent that implements it. The agent that reviews the implementation is not the agent that wrote the spec in the same context window. The agent that approves changes to instructions is not an agent.
3. **No honor-system fallbacks.** Old gates that accepted self-attested evidence are removed once the new system is enforcing, not kept as backup. Overlapping systems drift; agents satisfy the cheapest gate.
4. **Operational realism.** The system must not stall on infra outages, flakes, or production emergencies. Escalation ladders and escape hatches are designed explicitly.
5. **Observable and self-testing.** Every verification run, escalation, and override is auditable. A daily chaos test proves the system still works.

## Non-goals

- Verifying third-party integrations we don't control (e.g., an issue that "makes an API call to Clerk" — we verify our wrapper, not Clerk itself)
- Performance benchmarking (that's a separate concern with a separate harness)
- UI visual regression beyond what Playwright screenshots already provide
- Replacing existing orthogonal gates (state machine, department labels, assignment policy, etc.) — only the quality/evidence gates are in scope

## The two QA agents

**Frontend QA & Code Review Agent** (new, replaces old QA Agent)
- Owns: `url`, `lib_frontend`
- Writes: Playwright specs (anonymous + authenticated contexts), visual and a11y assertions
- Reviews: UI PRs, component API changes, frontend package changes
- Skills assigned (core 4): `paperclip`, `capability-check`, `issue-attachments`, `para-memory-files`
- Skills assigned (discipline): `dogfood`, `code-reviewer`, `verification-before-completion`, `requesting-code-review`, `receiving-code-review`
- Skills assigned (acceptance — new, replacing old `playwright-expert` + `qa-only`): `acceptance-viracue`, `acceptance-rtaa`, `acceptance-paperclip-frontend`
- Model: Sonnet 4.6 minimum (visual reasoning benefits from higher-tier)
- Adapter: `claude_local`

**Backend QA & Code Review Agent** (new)
- Owns: `api`, `migration`, `cli`, `config`, `data`, `lib_backend`
- Writes: curl + JSON schema specs, SQL migration + rollback tests, vitest regression tests, bash exit-code tests, schema validators
- Reviews: server PRs, DB changes, infra/CI changes, backend package changes
- Skills assigned (core 4): same as Frontend QA
- Skills assigned (discipline): `tdd`, `code-reviewer`, `systematic-debugging`, `log-diagnosis`, `verification-before-completion`, `requesting-code-review`, `receiving-code-review`
- Skills assigned (acceptance — new): `acceptance-api-specs`, `acceptance-migrations`, `acceptance-cli-scripts`, `acceptance-configs`
- Model: Opus 4.6 (SQL + config reasoning)
- Adapter: `claude_local`

Both agents replace the existing QA Agent (`24da232f-9ee1-435b-bf23-aa772ad5a981`). The old agent is terminated in Phase 5. Its open issues drain naturally on the old gates.

## Deliverable type taxonomy

Every issue created after the Phase 4 cutover must have a `deliverable_type` field. Issues created before the cutover are grandfathered (exempt).

| Type | Description | Routed to | Runner |
|---|---|---|---|
| `url` | Public or auth-gated webpage | Frontend QA | Playwright (remote VPS) |
| `api` | HTTP API endpoint | Backend QA | curl + JSON schema (in-container) |
| `migration` | SQL schema migration | Backend QA | psql against ephemeral PG (in-container) |
| `cli` | Executable script/binary | Backend QA | bash + exit code + stdout check |
| `config` | env, docker, workflow YAML | Backend QA | schema validator (actionlint, ajv, `docker compose config`) |
| `data` | One-shot DB operation | Backend QA | pre/post assertion script, idempotent |
| `lib_frontend` | UI package code with no URL surface | Frontend QA | vitest (pre-written test by Frontend QA) |
| `lib_backend` | Server package code | Backend QA | vitest (pre-written test by Backend QA) |
| `agent_instructions` | Changes to AGENTS.md, HEARTBEAT.md, SOUL.md, skills | **Board only** | Diff review, no runner |
| `docs` | Documentation-only | Either (by content) | Exempt — diff review only |
| `investigation` | Research/analysis task | Either | Exempt — delivery gate still requires writeup as work product |
| `none` | Non-code task | Any | Exempt from verification gate entirely |
| `multi_atomic` | **Board flag, not a type** — full-stack change that can't be decomposed | Both QA agents in sequence | Both runners must pass |

Default for non-code issues: `none`. Default for `docs` issues: `docs`. Everything else requires explicit selection at issue creation (UI dropdown; server-side gate rejects null after cutover). `multi_atomic` is a separate boolean field on the issue set only by board users — agents cannot self-flag.

## Spec storage in Paperclip skills

All acceptance specs live in the Paperclip repo, organized as skills assigned to the QA agents. This gives us one review surface (Paperclip PRs), one audit trail (Paperclip git history), one CI pipeline (existing Paperclip checks), and it leverages the existing skill assignment system for agent-to-product routing.

**New skill structure:**

```
skills/
├── acceptance-viracue/
│   ├── SKILL.md                    # When to use, how Viracue auth works, config pointers
│   ├── playwright.config.ts        # Viracue-specific Playwright config (base URL, projects, auth)
│   ├── helpers/
│   │   └── login-clerk.ts          # Clerk login flow helper
│   └── tests/
│       ├── DLD-2793.url.spec.ts    # One spec per issue
│       └── DLD-XXXX.url.spec.ts
├── acceptance-rtaa/                # Same structure, RTAA-specific
├── acceptance-paperclip-frontend/  # For Paperclip's own UI
├── acceptance-api-specs/           # Backend — API contract specs
│   ├── SKILL.md
│   ├── helpers/
│   │   └── schema-validator.ts
│   └── tests/
│       └── DLD-XXXX.api.spec.ts
├── acceptance-migrations/          # Backend — migration dry-runs
│   ├── SKILL.md
│   ├── helpers/
│   │   └── ephemeral-pg.ts
│   └── tests/
│       └── DLD-XXXX.migration.sql
├── acceptance-cli-scripts/         # Backend — CLI/shell tests
├── acceptance-configs/             # Backend — config validators
└── acceptance-lib-tests/           # Both — pre-written vitest regression tests
    └── tests/
        └── DLD-XXXX.lib.test.ts
```

**Skill consolidation (Phase 5 cleanup):**
- `playwright-expert` skill → deprecated, absorbed into per-product `acceptance-*` skills
- `qa-only` skill → deprecated, absorbed into `code-reviewer` + per-product acceptance skills
- `dogfood` skill → kept, referenced by all acceptance skills as a discipline principle
- `code-reviewer` skill → kept, assigned to both QA agents

**Spec file naming convention:** `<ISSUE_IDENTIFIER>.<type>.spec.<ext>`
- `DLD-2793.url.spec.ts` — Playwright TypeScript
- `DLD-1234.api.spec.ts` — HTTP contract test
- `DLD-5678.migration.sql` — SQL migration with rollback assertion
- `DLD-9999.cli.test.sh` — Bash script

The verification worker dispatches to the correct runner based on the file suffix.

## The 6-phase issue lifecycle

Every code issue goes through these six phases. The state machine enforces each transition; gates verify each prerequisite.

| Phase | Status | Actor | Gate |
|---|---|---|---|
| 1. Spec authoring | `todo` → `spec_draft` | Primary QA (Frontend or Backend by type) | Must create `<DLD-XXXX>.<type>.spec.<ext>` in the correct skill directory |
| 2. Spec cross-review | `spec_draft` → `spec_approved` | **Opposite** QA | Must approve spec (comment + assertion count ≥ 3 + target reference grep check) |
| 3. Implementation | `spec_approved` → `in_progress` | Engineer | No new gate; existing state machine applies |
| 4. Verification | `in_progress` → `in_review` | Worker (automatic on PR push) | `assertVerificationPassed` — worker runs spec, trace stored as evidence |
| 5. Impl review | `in_review` → `done` | Primary QA in **fresh heartbeat** | Primary QA re-reviews PR + verification trace, spec file is **read-only** in this phase |
| 6. Cross-review (high-risk only) | `done` blocked until opposite QA approves | Opposite QA, fresh context | Triggered by `risk: high` label |

New statuses: `spec_draft` and `spec_approved`. Added to the state machine in Phase 3. Old state machine transitions remain valid for non-code issues.

**Primary QA vs opposite QA:**
- `url`, `lib_frontend` → Frontend QA primary, Backend QA opposite
- `api`, `migration`, `cli`, `config`, `data`, `lib_backend` → Backend QA primary, Frontend QA opposite

**Fresh-context enforcement:** The spec-authoring heartbeat and the impl-review heartbeat run as separate runs with separate prompts. The impl-review run's workspace has the spec file mounted read-only (filesystem permission, not just convention). If the reviewer agent thinks the spec is wrong, it must open a new issue to fix the spec — it cannot silently edit the spec to make the PR pass.

**High-risk auto-detection:** Backend QA runs a grep pass over the PR diff for auth/secret/migration/workflow/billing keywords. If any match, the issue auto-labels `risk: high` and Phase 6 cross-review is required.

**Incident escape hatch:** Issues with `priority: incident` (board-only) skip Phase 1 and Phase 2. Engineer implements immediately, deploys, then primary QA writes a regression spec in a post-hoc verification run. If the regression spec fails, the fix is reverted via automated rollback (docker image rollback or git revert + redeploy). `incident` priority is auditable and rate-limited — more than 3 incidents per week triggers a board review.

## The verification worker

Lives in the same Paperclip server container at `server/src/services/verification/`. A single orchestrator dispatches to type-specific runners.

**Interface:**

```typescript
interface VerificationWorker {
  runSpec(input: {
    issueId: string;
    deliverableType: DeliverableType;
    specPath: string;      // relative to paperclip repo root
    context?: 'anonymous' | 'authenticated';  // url only
    targetSha?: string;    // for deploy SHA verification
  }): Promise<VerificationResult>;
}
```

**Runner dispatch (Phase 1 ships url only, Phases 2-4 add the rest):**

| Type | Runner module | Execution location | Key dependencies |
|---|---|---|---|
| `url` | `runners/playwright-runner.ts` | SSH to browser-test VPS 207.148.14.165 | existing `browser-test` CLI + Playwright |
| `api` | `runners/api-runner.ts` | In-container | `node-fetch`, `ajv` for JSON schema |
| `migration` | `runners/migration-runner.ts` | In-container | `pg` + ephemeral Docker PG 16 |
| `cli` | `runners/cli-runner.ts` | In-container | `child_process.execFile` + bash |
| `config` | `runners/config-runner.ts` | In-container | `actionlint`, `ajv`, `docker compose config` |
| `data` | `runners/data-runner.ts` | In-container | `pg` against ephemeral or sandboxed DB |
| `lib_*` | `runners/vitest-runner.ts` | In-container | `vitest` against workspace package |

**Deploy SHA verification (gap 2, Phase 1 requirement):**

The URL runner must confirm the deployed SHA matches the expected commit before running the spec. Each product exposes a build manifest at a known path:

```
# Viracue
curl -s https://viracue.ai/__build.json
# { "sha": "87948510322b0506a416c9d19b0a582582b62d4e", "deployed_at": "2026-04-13T..." }
```

If `manifest.sha !== input.targetSha`, the runner returns `unavailable: deploy_not_ready_yet` and the retry budget applies. 3 retries × 60s gives a 3-minute deploy grace window. After exhaustion, the escalation ladder fires with "deploy timeout" as the root cause, not "verification failed" — different remediation path.

Adding the build manifest to Viracue is part of Phase 1. Other products add their manifests as they come into scope.

**Retry budget and unavailability:**
- 3 attempts, 60s backoff between attempts
- All attempts persist in `verification_runs` with incrementing `attempt_number`
- `unavailable` results (worker down, SSH timeout, deploy not ready) do not count against the retry budget — they just delay
- Confirmed `failed` results (spec ran, produced assertions, some failed) skip remaining retries — no point running the same fail again
- After all retries exhausted or definitive failure, the gate hard-blocks and the escalation record opens

**Fail-open policy for infra outages:** If after retry exhaustion the worker is still `unavailable` (never got a real run), the gate logs `verification_unavailable_bypass`, fires a board alert, and **does not block**. Rationale: a VPS reboot must not freeze every issue. The alert ensures the board knows immediately and can revert any issue that slipped through while investigating.

**Spec quality gates (gap 4):** Before a spec is accepted into Phase 2 (cross-review), the spec_ready gate runs mechanical checks:
1. File exists at expected path
2. File contains ≥ 3 `expect(` or assertion-equivalent calls (`assert.*`, `should.*`, bash `test` / `[`)
3. File contains at least one literal reference to the deliverable target (URL, endpoint path, table name, file path — extracted from the issue's `verification_target` field, which is required at issue creation)

Any check fails → `spec_draft` cannot transition to `spec_approved`. Opposite QA cross-review happens only AFTER mechanical checks pass, so the human-equivalent review step doesn't waste cycles on obviously-broken specs.

## Data model changes

**New tables** (one migration, Phase 1):

```sql
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

CREATE TABLE verification_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  verification_run_id UUID REFERENCES verification_runs(id),
  user_id TEXT NOT NULL,
  justification TEXT NOT NULL CHECK (length(justification) >= 20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE spec_metadata (
  spec_path TEXT PRIMARY KEY,
  total_runs INTEGER NOT NULL DEFAULT 0,
  pass_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  flake_count INTEGER NOT NULL DEFAULT 0,   -- transitions from fail→pass within a window
  last_run_at TIMESTAMPTZ,
  last_flake_at TIMESTAMPTZ,
  flaky BOOLEAN NOT NULL DEFAULT false,
  maintenance_issue_id UUID REFERENCES issues(id)
);

CREATE TABLE verification_chaos_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario TEXT NOT NULL,
  expected_outcome TEXT NOT NULL,
  actual_outcome TEXT NOT NULL,
  passed BOOLEAN NOT NULL,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**New columns on `issues`:**

```sql
ALTER TABLE issues
  ADD COLUMN deliverable_type TEXT,
  ADD COLUMN verification_target TEXT,  -- the URL, endpoint, table name, etc. — required for code issues
  ADD COLUMN verification_run_id UUID REFERENCES verification_runs(id),
  ADD COLUMN verification_status TEXT,
  ADD COLUMN multi_atomic BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN risk_high BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN incident_priority BOOLEAN NOT NULL DEFAULT false;
```

**New state machine statuses:** `spec_draft`, `spec_approved` added to the `issues.status` enum check constraint.

## Gates: adds, changes, removals

**New gates** (Phases 2-4):

| Gate | Fires on | What it checks |
|---|---|---|
| `deliverable_type_required` | Issue creation | `deliverable_type` is set (post-cutover code issues only) |
| `verification_target_required` | Issue creation | `verification_target` is set for types that need it |
| `spec_ready` | `todo` → `spec_draft` | Spec file exists at the expected path, in the correct skill |
| `spec_quality` | `spec_draft` → `spec_approved` | Assertion count ≥ 3, target reference present |
| `spec_cross_reviewed` | `spec_draft` → `spec_approved` | Comment from opposite QA containing `SPEC APPROVED` pattern |
| `implementation_started` | `spec_approved` → `in_progress` | Issue is `spec_approved`, assignee is the engineer (not QA) |
| `verification_passed` | `in_review` → `done` | `verification_runs` latest entry is `status: passed` or `overridden` |
| `high_risk_cross_review` | `in_review` → `done` | If `risk_high = true`, requires approval comment from opposite QA in fresh context |
| `agent_instructions_board_only` | Any instruction-file PR | PR touching `onboarding-assets/`, `AGENTS.md`, etc. requires board approval (via CODEOWNERS-equivalent check) |

**Existing gates — disposition:**

| Gate | Action | When |
|---|---|---|
| `assertDeliveryGate` | **Keep** | Unchanged |
| `assertQAGate` (QA PASS comment) | **Demote to advisory** | Phase 5 — PATCH handler check removed, comment convention stays as audit signal |
| `done_requires_review_cycle` | **Keep** | Unchanged |
| `assertEngineerBrowseEvidence` | **Remove** | Phase 5 — replaced by trace-as-evidence |
| `assertQABrowseEvidence` | **Remove** | Phase 5 — replaced by trace-as-evidence |
| `assertAgentTransition` | **Extend** | Phase 3 — add `spec_draft`, `spec_approved` to state machine |
| `assertCancellationReplacement` | **Keep** | Unchanged |
| `assertAgentAssignmentPolicy` | **Keep** | Unchanged |
| `assertAgentCommentRequired` | **Keep** | Unchanged |
| `assertReviewHandoff` | **Keep** | Unchanged |
| `initiative_has_active_children` | **Keep** | Unchanged |
| `department_label_required` | **Keep** | Unchanged |
| `detectDirectDbClosures` sweeper | **Extend** | Phase 4 — add `verification_run_id IS NULL AND status='done'` check |
| `expireTerminatedRunLocks` sweeper | **Keep** | Unchanged |
| `sweepUnpickedAssignments` sweeper | **Keep** | Unchanged |

## Escalation ladder

When a verification run returns `failed` (not `unavailable`), a `verification_escalations` row is created and the sweeper runs the ladder.

**Normal priority:**

| Rung | Elapsed | Action |
|---|---|---|
| 0 | T+0 | @assignee, status forced to `in_progress`, worker posts failure comment with trace link |
| 1 | T+30m | @manager (role-based: CTO/CMO/CPO/CEO) |
| 2 | T+2h | @CEO |
| 3 | T+4h | Board dashboard + Slack/Discord alert |
| 4+ | every +4h | Repeat board alert until resolved |

**Urgent priority:** 10m / 30m / 1h / repeat
**Low priority:** 4h / 12h / 24h / repeat
**Incident priority:** no escalation — handled by auto-revert

**Rules:**
- Escalation only for confirmed `failed` results, never for `unavailable`
- Escalation @mentions but does not reassign
- Passing verification cancels the ladder and sets `resolved_at`
- Board override halts the ladder at any rung and sets `resolved_at`
- Reverts (incident priority) mark `resolution: reverted`

Implemented as `escalateFailedVerifications()` sweeper in `server/src/services/heartbeat.ts`, runs on the existing 30s scheduler tick.

## Flake tracking (gap 7)

Every verification run updates `spec_metadata`:
- `pass_count` / `fail_count` incremented
- If the transition is `fail → pass` within 7 days, increment `flake_count`
- If `flake_count >= 2` in 7 days, set `flaky = true`

Effects when `flaky = true`:
- Retry budget increases from 3 to 6 attempts
- Escalation comments include "this spec has flaked N times in the past 7 days"
- If `flake_count >= 5` or `flaky` persists > 14 days, sweeper auto-opens a maintenance issue assigned to the QA agent that wrote the spec, titled "Fix flaky spec <spec_path>"

This keeps flake debt from accumulating invisibly and makes spec authors accountable for their own specs' reliability.

## QA feedback loop (gap 8)

**Weekly audit (Phase 4 or 5, can be late):** A new `verification-auditor` role on the CEO agent runs every Monday:
- Sample 5 random `passed` verification runs from the past week
- Re-run each spec adversarially (alter a key assertion, re-run, confirm it fails — proves the spec had teeth)
- Open a coaching issue assigned to the QA agent that wrote the spec if any audit finds a no-op spec

**QA performance dashboard (Phase 4):** New UI page `/verification-quality` showing per-QA-agent metrics:
- Specs authored per week
- Opposite-QA approval rate on first submission
- Verification failures caught (true positives)
- False passes (specs that passed but the delivery was later found broken) — rare, high signal
- Board overrides on issues they closed
- Time-to-approve average
- Flake rate on their specs

## Verification system self-test (gap 10)

**Daily chaos cron:**
- A board-owned scheduled task runs every day at 0300 UTC
- Creates a hidden test issue assigned to a dummy target URL (e.g., `https://viracue.ai/__test/always-fails`)
- The test spec asserts the page returns 200 with specific content
- The target URL is intentionally broken (returns 404 or redirects)
- The chaos test asserts the verification gate blocks the transition to `done`
- If the gate DOES block → chaos test passes, logged in `verification_chaos_runs`
- If the gate does NOT block → chaos test fails, immediate board alert, system treated as compromised

**Additional self-test:** The verification worker's own PRs require Backend QA specs + verification before merging. Recursive self-application — if the system can't verify itself, it can't verify anything.

## Immutable agent instructions (gap from decision 2)

Agent instruction files (`AGENTS.md`, `HEARTBEAT.md`, `SOUL.md`, `CLAUDE.md`, skill files, gate code, workflow YAML) cannot be edited from an agent's workspace context. Two enforcement layers:

1. **Filesystem:** The `onboarding-assets/` directory and related paths are mounted read-only in agent workspaces. Agents can read them but not write.
2. **PR policy:** A new check in `pr-policy.yml` rejects PRs touching those paths unless the PR author is a board user OR the PR has a board approval comment. This is an extension of the existing policy workflow that already blocks CI workflow edits.

Agents can draft PRs proposing instruction changes (open a branch, write a proposal, open a PR) but cannot merge them. Merging requires board action. This matches the "control plane is not deployable by the fleet it controls" principle.

## Rollout phases

Each phase ships as its own PR, goes through the existing Paperclip CI (verify + policy + ai-review), auto-deploys on merge, and **gets a self-code-review pass before the next phase starts**. Self-code-review invokes `superpowers:code-reviewer` skill against the phase's diff.

### Phase 1: Frontend QA agent + URL runner (end-to-end vertical slice) — ~1 week

**Goal:** One new QA agent, one runner, one on-demand endpoint, working against DLD-2793 as the smoke test. No gates wired yet — this phase proves the vertical works.

Tasks:
1. DB migration 0051: all new tables + issue columns
2. Drizzle schemas for new tables + issue columns
3. `ssh-runner.ts` helper
4. `build-manifest.ts` — fetches `/__build.json` from target product, parses SHA
5. Viracue build manifest endpoint — new Viracue PR to add `public/__build.json` generation at build time
6. `playwright-runner.ts` — SSH + Playwright + trace extraction
7. `trace-uploader.ts` — upload trace bundle to `issue_attachments`
8. `verification-worker.ts` — orchestrator with retry budget
9. `POST /api/issues/:id/verify` board-only endpoint for manual testing
10. `acceptance-viracue` skill scaffold — SKILL.md, playwright.config.ts, empty `tests/` directory, login-clerk helper stub
11. Frontend QA Agent creation — new agent in DB with adapter_config, skill assignments, instructions
12. Write DLD-2793.url.spec.ts in `acceptance-viracue/tests/` — the failing spec
13. Smoke test: call `/api/issues/DLD-2793/verify`, assert `failed` result, view trace
14. Self-code-review the phase 1 diff

### Phase 2: Backend QA agent + API/migration runners — ~1 week

Tasks:
1. `api-runner.ts` (curl + JSON schema via ajv)
2. `migration-runner.ts` (ephemeral PG 16 in Docker, apply + rollback)
3. `acceptance-api-specs` skill scaffold
4. `acceptance-migrations` skill scaffold
5. Backend QA Agent creation
6. Smoke test: create a test issue with a deliberately-wrong API endpoint, assert worker catches it
7. Smoke test: create a test issue with a non-rollback-able migration, assert worker catches it
8. Self-code-review

### Phase 3: Remaining runners + state machine + gates in log-only mode — ~4 days

Tasks:
1. `cli-runner.ts`
2. `config-runner.ts`
3. `data-runner.ts`
4. `vitest-runner.ts` (for lib_frontend / lib_backend)
5. Remaining acceptance skills (`acceptance-cli-scripts`, `acceptance-configs`, `acceptance-lib-tests`)
6. State machine extension: add `spec_draft`, `spec_approved` statuses
7. `deliverable_type_required` gate — log-only mode
8. `spec_ready` gate — log-only mode
9. `spec_quality` gate — log-only mode
10. `verification_passed` gate — log-only mode
11. Run 48h in log-only mode, collect divergence metrics (how often new gates would block vs old gates pass)
12. Self-code-review

### Phase 4: Gate enforcement + escalation + overrides + dashboard — ~4 days

Tasks:
1. Flip all new gates from log-only to enforcement
2. `escalateFailedVerifications()` sweeper
3. `verification-overrides` table + `POST /api/issues/:id/verification-override` endpoint
4. `BOARD_ALERT_WEBHOOK_URL` wiring + alert helper
5. `/verification-failures` dashboard page (UI)
6. Flake tracking (`spec_metadata` updates + flaky-spec sweeper)
7. Extend `detectDirectDbClosures` with verification bypass check
8. Per-product auth strategies scaffold (`strategies/clerk-login.ts`)
9. Immutable instruction files — filesystem mount change + pr-policy extension
10. High-risk auto-detection (grep-based)
11. `spec_cross_reviewed` gate
12. `implementation_started` gate
13. `high_risk_cross_review` gate
14. Self-code-review

### Phase 5: Old gate cleanup + old QA agent termination — ~2 days

Tasks:
1. Delete `assertEngineerBrowseEvidence`
2. Delete `assertQABrowseEvidence`
3. Demote `assertQAGate` to advisory (remove hard-block, keep comment convention in AGENTS.md)
4. Rewrite CLAUDE.md "Quality gates" section to reflect new system
5. Update AGENTS.md, `dogfood` skill, `code-reviewer` skill to reference new workflow
6. Deprecate `playwright-expert` + `qa-only` skills (rename to `.deprecated/` directory)
7. Terminate old QA Agent (`24da232f`), archive its instructions to `docs/archive/qa-agent-v1/`
8. Verify old agent's open issues have drained
9. Self-code-review

### Phase 6: Self-test + feedback loop + incident hatch — ~4 days

Tasks:
1. Daily chaos test cron + `verification_chaos_runs` table
2. Weekly QA audit — new `verification-auditor` skill assigned to CEO
3. QA performance dashboard `/verification-quality`
4. `incident` priority level — new priority enum value, gate skip logic
5. Auto-revert on incident post-hoc spec failure (docker image rollback helper)
6. Self-code-review

## Success criteria

Evaluated at 2026-04-27 (two weeks after Phase 6 ships, approximately):

- **Zero faked deliveries slip through.** Measured by Damon's manual catches dropping to zero.
- **<5% flake rate** on verification runs.
- **<1% `verification_unavailable`** rate.
- **≤3 board overrides per week.**
- **Zero chaos test failures** — the system's self-test catches 100% of injected fakes.
- **≥90% of code issues** have deliverable_type set at creation.
- **Zero agents** editing instruction files successfully (gate blocks all attempts).

## Rollback plan

Each phase is independently reversible because the old gates stay in place until Phase 5. If any phase causes a production issue:

- **Phase 1:** revert the PR. No agent-facing behavior changes — on-demand endpoint is board-only.
- **Phase 2:** revert the PR. Same as above.
- **Phase 3:** gates are log-only; revert only removes log entries. No blocking behavior to undo.
- **Phase 4:** gates are enforcing. Set `VERIFICATION_WORKER_ENABLED=false` env var to disable new gates entirely. Old gates still enforce. No data loss.
- **Phase 5:** the dangerous one. Once old gates are deleted, rolling back requires re-adding them. Do not ship Phase 5 until Phase 4 has run enforcing for ≥5 days with zero board overrides on `verification_passed` gate failures.
- **Phase 6:** chaos test and feedback loop can be disabled independently.

## Open questions for the 2026-04-20 checkpoint

- Did the 30m/2h/4h escalation ladder match real-world fix times?
- What's the first non-URL deliverable type to ship in Phase 2 — API or migration? (Pick based on what the team is currently working on.)
- Did the spec-cross-review phase add meaningful latency, or is it catching real spec-quality issues?
- Is the build manifest pattern working for Viracue? Should we extend it to other products before Phase 3?
