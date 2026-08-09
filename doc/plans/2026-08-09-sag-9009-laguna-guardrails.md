# Laguna Lane Durability Guardrails Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with TDD and verification checkpoints.

**Goal:** Add three stdlib-only, idempotent `scripts/` guardrails for runtime SHA drift, non-self-killing cutover, and Laguna adapter health without privileged or status-mutating recovery.

**Architecture:** G1 resolves the live service checkout and compares its HEAD and required ancestors to `ops/runtime-target.json`, recording distinct drift states in a local ledger before issuing a bounded alert. G2 is a shell harness whose deploy action is an injected executable and whose restart sequence runs in a detached user scope. G3 polls Ollama and the five fixed Laguna agent IDs, emits bounded owner wakes/digest entries, and requests—but never performs—privileged recovery.

**Tech Stack:** Python 3 standard library, POSIX shell, `systemd-run --user --scope`, `urllib`, `git`, and existing `recovery_sweeper.py` API/comment conventions.

---

### Task 1: Test the drift and watchdog decision boundaries

**Files:**
- Create: `scripts/test_laguna_guardrails.py`

- [ ] Write tests for required-ancestor failure, staged-vs-running working-directory mismatch, single-state alert dedupe, Ollama eviction/second-model detection, ghost/error agent detection, and no mutation/sudo recovery output.
- [ ] Run `python3 -m unittest scripts/test_laguna_guardrails.py` and confirm it fails because the guardrail modules do not yet exist.

### Task 2: Implement G1 runtime SHA drift detection

**Files:**
- Create: `scripts/runtime_sha_drift_check.py`
- Create: `ops/runtime-target.json`

- [ ] Keep all host and API access injectable through environment variables so selftests use temporary fixtures and live mode uses the documented service/drop-in fallbacks.
- [ ] Report live SHA, target SHA, ancestor verdicts, and staged-but-not-restarted state; write one alert ledger entry per distinct `(live_sha, target_sha)` state.
- [ ] Run the focused Python tests, `dry`, `selftest`, and the host-safe `live`/`dry` command where the required service metadata is available.

### Task 3: Implement G2 detached cutover harness

**Files:**
- Create: `scripts/runtime_cutover.sh`

- [ ] Add `live`, `dry`, and `selftest` modes with bounded drain polling, an executable deploy hook, detached `systemd-run --user --scope` execution, daemon reload/restart, health polling, and G1 re-check.
- [ ] Make the selftest prove the throwaway scope survives launcher termination when user systemd is available, while keeping unavailable systemd explicit and non-mutating.
- [ ] Run shell syntax checks and the harness selftest; do not execute live cutover.

### Task 4: Implement G3 Laguna adapter watchdog

**Files:**
- Create: `scripts/laguna_adapter_watchdog.py`

- [ ] Poll Ollama `/api/ps` and `/api/tags` plus the five Laguna agent detail routes, asserting the single resident model and `OLLAMA_MAX_LOADED_MODELS=1` policy from read-only data/config.
- [ ] Detect eviction, second-model load, adapter failure, ghost running state, and bounded stale-running states; issue at most one owner wake per target and one digest/request surface per distinct state.
- [ ] Run focused tests, `dry`, and `selftest`; inspect the source for status mutation and privileged command absence.

### Task 5: Verify and hand off

**Files:**
- No additional source files.

- [ ] Run all three selftests and relevant existing script tests, capture the current-host G1 result if service metadata is available, and review the diff for unrelated changes.
- [ ] Post evidence and the parameterized cutover-hook contract to SAG-8938 with an @-mention of its owner; route the implementation to peer review without claiming live cutover verification.
