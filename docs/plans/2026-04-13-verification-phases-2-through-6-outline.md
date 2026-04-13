# Verification System — Phases 2 through 6 Outline

> **For Claude:** Each phase below is a scope sketch, NOT a detailed implementation plan. Before executing any phase, a fresh detailed plan must be written in a new `docs/plans/2026-XX-XX-verification-phase-N-<name>.md` document using `superpowers:writing-plans`, incorporating learnings from the just-completed prior phase.

**Reference:** [docs/plans/2026-04-13-verification-system-design-v2.md](./2026-04-13-verification-system-design-v2.md)

---

## Phase 2: Backend QA Agent + API/migration runners

**Why:** Cover the second-most-common deliverable class (API endpoints and DB migrations) and prove the runner-dispatch model works for non-URL types.

**Scope:**
- Create Backend QA Agent (new agent, new instructions, new HEARTBEAT)
- `api-runner.ts` — HTTP contract testing via node-fetch + ajv JSON schema
- `migration-runner.ts` — ephemeral PG 16 container, apply + rollback assertions
- `acceptance-api-specs` skill scaffold
- `acceptance-migrations` skill scaffold
- Extend `VerificationWorker.runSpec()` to dispatch on `deliverableType`
- Smoke tests: deliberately-broken API endpoint, non-rollback-able migration

**Exit criteria:**
- Backend QA Agent exists, idle
- Smoke test: a fake API endpoint (returns wrong JSON shape) is caught by api-runner
- Smoke test: a migration missing its rollback is caught by migration-runner
- Self-code-review passes

**Estimate:** ~1 week

---

## Phase 3: Remaining runners + state machine + gates in log-only mode

**Why:** Get the full runner suite in place and start observing how the new gates would behave in production without actually blocking anything. This is the safety phase — we watch for 48h before enforcement.

**Scope:**
- `cli-runner.ts` (bash + exit code + stdout regex)
- `config-runner.ts` (actionlint, ajv, `docker compose config -q`)
- `data-runner.ts` (pre/post assertion scripts, idempotency check)
- `vitest-runner.ts` (for lib_frontend / lib_backend)
- `acceptance-cli-scripts`, `acceptance-configs`, `acceptance-lib-tests` skills
- State machine: add `spec_draft` and `spec_approved` statuses
- Log-only gates:
  - `deliverable_type_required`
  - `verification_target_required`
  - `spec_ready`
  - `spec_quality`
  - `verification_passed`
- Divergence metrics collection: log every case where new gate would block but old gate passed (and vice versa)
- 48h observation window

**Exit criteria:**
- All 6 runner types working
- Log-only gates fire but don't block
- Divergence report shows <5% false-positive rate on new gates
- Self-code-review passes

**Estimate:** ~4 days + 48h observation

---

## Phase 4: Gate enforcement + escalation + overrides + dashboard

**Why:** This is the "flip the switch" phase. Gates start actually blocking. Escalation, overrides, and the operator dashboard make the enforced system livable.

**Scope:**
- Flip log-only gates to enforcement mode
- `escalateFailedVerifications()` sweeper in heartbeat.ts, wired into scheduler tick
- `verification_overrides` write path + `POST /api/issues/:id/verification-override` endpoint
- `BOARD_ALERT_WEBHOOK_URL` env + alert helper (Slack/Discord)
- `/verification-failures` UI dashboard page
- Flake tracking: `spec_metadata` updates on every run, flaky flag + auto-opened maintenance issues
- Extend `detectDirectDbClosures` with verification bypass check
- Per-product auth strategies: `strategies/clerk-login.ts`, `strategies/api-token.ts`, `strategies/paperclip-session.ts`
- Seeded QA test users in Clerk (Viracue) — one-time Clerk console action
- `spec_cross_reviewed` gate (opposite-QA comment required)
- `implementation_started` gate (spec_approved → in_progress only)
- `high_risk_cross_review` gate (grep-based risk detection + opposite QA approval for high-risk)
- Immutable instruction files: read-only mount in agent workspaces, pr-policy extension
- `/verification-failures` dashboard: open escalations, current rung, time-to-next-rung, trace links, override button

**Exit criteria:**
- New gates are enforcing
- Daily chaos test (added in Phase 6) passes consistently OR is explicitly scheduled for Phase 6
- Escalation sweeper runs cleanly in production for 24h without noise alerts
- Board override endpoint tested and working
- Dashboard viewable
- Self-code-review passes

**Estimate:** ~4 days

**Risk:** This is the highest-risk phase. Rollback plan: `VERIFICATION_WORKER_ENABLED=false` env var disables all new gates; old gates still active until Phase 5.

---

## Phase 5: Old gate cleanup + old QA agent termination

**Why:** Remove the cheap honor-system path so agents can't drift back to it. This phase is irreversible — do not ship until Phase 4 has been enforcing with zero board overrides for ≥5 days.

**Scope:**
- Delete `assertEngineerBrowseEvidence` from `server/src/routes/issues.ts`
- Delete `assertQABrowseEvidence`
- Demote `assertQAGate`: remove PATCH handler check, keep `QA: PASS` comment convention in AGENTS.md as audit signal
- Rewrite `CLAUDE.md` "Quality gates" section to describe the new verification system (remove stale old-gate documentation)
- Update `AGENTS.md` (root + onboarding-assets/default) with new 6-phase workflow
- Update `dogfood` skill to reference trace-as-evidence instead of screenshot-as-evidence
- Update `code-reviewer` skill with the spec-cross-review pattern
- Deprecate `playwright-expert` + `qa-only` skills — rename to `.deprecated/` directory, update any references
- Terminate old QA Agent (`24da232f-9ee1-435b-bf23-aa772ad5a981`):
  - Wait until it has zero open issues (or bulk-reassign to the new QA agents)
  - Set status to `terminated`
  - Archive instructions to `docs/archive/qa-agent-v1/`
- Update the relevant test files (some existing tests for old gates become stale)
- Update memory files: `gate-enforcement-rollout.md`, `verification-system-design.md`

**Exit criteria:**
- Old gates gone from codebase
- All tests pass
- Old QA Agent terminated with zero open issues
- Zero agents reference the old gate names in their instructions
- CLAUDE.md is accurate
- Self-code-review passes

**Estimate:** ~2 days

**Rollback:** Expensive. Requires re-adding deleted gate functions, re-enabling old gates in the PATCH handler. Only do this if Phase 5 causes production failures, and prefer to fix forward in Phase 4 territory instead.

---

## Phase 6: Self-test + feedback loop + incident hatch

**Why:** The system has to prove it still works, learn from its own mistakes, and have an operational escape valve for emergencies. Without Phase 6 the system is correct today but can silently rot.

**Scope:**
- **Daily chaos test:** board-owned scheduled task creates a hidden test issue with a deliberately-failing spec against a known-bad endpoint (e.g. `https://viracue.ai/__test/always-fails`), runs it through the full gate pipeline, asserts the system blocks the transition to `done`. Logs to `verification_chaos_runs`. Alerts board on failure.
- **Weekly QA audit:** new `verification-auditor` skill assigned to CEO. Every Monday, sample 5 recent passed verification runs, re-run specs with one assertion flipped to confirm they have teeth. Open coaching issues for any no-op specs.
- **QA performance dashboard:** `/verification-quality` UI page. Per-QA-agent metrics: specs authored, opposite-QA approval rate, verification failures caught, false-pass rate, board override count, time-to-approve, flake rate.
- **`incident` priority level:**
  - New priority value: `incident` (board-only, rate-limited to 3/week)
  - Gate skip: incident issues bypass Phase 1 and Phase 2 (spec author + cross-review)
  - Engineer implements immediately, deploys immediately
  - Primary QA writes a regression spec in a post-hoc run
  - If regression spec fails → automated revert:
    - URL issues: docker image rollback via `PAPERCLIP_SERVER_IMAGE=$(cat current-image-prev)` on VPS
    - API/migration issues: git revert + redeploy
    - Rollback method configurable per product
  - Board gets alerted on every incident declaration and every auto-revert

**Exit criteria:**
- Chaos test has run for 7 consecutive days without false-passing
- QA audit has completed one full cycle with at least one coaching issue opened
- Dashboard viewable and shows meaningful data
- `incident` priority tested end-to-end (synthetic incident, engineer fix, post-hoc spec, pass or simulated revert)
- Self-code-review passes

**Estimate:** ~4 days

---

## Rollout summary

| Phase | Duration | Risk | Reversibility |
|---|---|---|---|
| 1 | ~1 week | Low | Easy (revert PR) |
| 2 | ~1 week | Low | Easy (revert PR) |
| 3 | ~4 days + 48h | Medium | Easy (log-only, no behavior change) |
| 4 | ~4 days | **High** | Medium (env flag disables, old gates intact) |
| 5 | ~2 days | **High** | **Hard** (must re-add deleted code) |
| 6 | ~4 days | Medium | Easy (feature-flag each component) |

**Total estimate:** ~5-6 weeks sequential, assuming each phase gets ~1 day of soak time before the next starts.

**Critical gates:**
- Do not ship Phase 5 until Phase 4 has been enforcing for ≥5 days with zero board overrides on verification gate failures
- Do not ship Phase 4 until Phase 3 log-only has run for ≥48h with <5% false-positive divergence
- Do not ship Phase 2 until Phase 1 smoke test (DLD-2793) has returned `failed` with a viewable trace

---

## Self-code-review after each phase

Every phase ends with a `superpowers:code-reviewer` invocation against the phase's full diff. The reviewer is instructed to focus on:

1. **Correctness** — does the code do what the plan said?
2. **Security** — command injection, auth bypass, secret handling
3. **Test coverage** — is every error path exercised?
4. **Performance** — any obvious O(n²), unbounded buffers, memory leaks
5. **Consistency** — does it follow existing Paperclip patterns (Drizzle, gate functions, sweeper pattern)
6. **Reversibility** — can this phase be rolled back cleanly?

High-severity findings block the next phase from starting until fixed.

---

## Memory update

After each phase completes, update `~/.claude/projects/-Users-damondecrescenzo-paperclip/memory/verification-system-design.md` with:
- What shipped
- What was discovered during implementation (gaps in the plan, unexpected constraints)
- What should change in subsequent phases based on what we learned
- Any new risks identified

This ensures future sessions pick up with accurate context.
