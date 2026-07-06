# Plan: Server-Side Execution Contract Enforcement (Stage 2)

Date: 2026-07-06
Status: partially shipped (V2 hidden storage/transport/UI live; warn-mode validation/logging live; hard 422 enforcement still pending)

## Context

Stage 1 added execution-contract rules to the bundled `paperclip` skill (`references/execution-contract.md`): managers include a contract with every delegated child issue, executors run preflight, QA reviews against the contract. This is instruction-level enforcement — agents follow it because the skill tells them to, but the server does not verify required contract presence.

V2 added hidden contract storage and transport: `issues.execution_contract`, API `executionContract`, issue detail/heartbeat-context/wake payload delivery, legacy description extraction, and a collapsed UI audit panel.

Stage 2 makes the contract structural, replicating the property that makes isolated-subagent handoffs (e.g. Claude Code's Agent tool) reliable: **the handoff artifact is the executor's primary starting context, and its presence is mechanically enforced.**

## Shipped / Proposed Changes

### 1. Contract validation on delegation

Shipped in warn mode. In the issue service/routes, when an **agent** creates an issue with `parentId` set:

- Read the hidden `executionContract` field. Legacy `## Execution Contract` description blocks may still be extracted for compatibility, but new delegation validation should target the JSON field.
- Validate required fields: `schemaVersion`, `contractType`, `taskType`, `core.objective`, `core.why`, non-empty `core.sourceOfTruth`, non-empty `core.acceptanceChecks`, `core.handoffNotes.managerReasoning`.
- Warn-mode behavior: create the child issue, then log `issue.execution_contract_warning` activity with field-level warnings. This is non-blocking and does not include the contract body in activity details.
- Future enforce-mode behavior: reject with `422` and a field-level error message when missing/invalid, mirroring the existing two-level topology enforcement (which already rejects grandchildren and >10 lanes — precedent for hard orchestration gates in this service).
- Human-created issues are exempt (agents reconstruct contracts for human requests, per the skill).
- Rollout flag: per-company setting (`instance_settings` or company metadata) `requireExecutionContracts: warn | enforce | off`, default `warn` initially; flip to `enforce` after contract adoption is visible in real issues.

### 2. Contract-driven wake payloads

Shipped in V2. `PAPERCLIP_WAKE_PAYLOAD_JSON` and `heartbeat-context` include the contract as a first-class field for execution-lane wakes, so the executor's starting context IS the contract rather than "go read the thread". QA-stage wakes include the same contract for mechanical comparison.

### 3. Protected-skill hardening (small)

Shipped. `companySkillService.deleteSkill()` rejects bundled root skills before usage checks. The guard treats `metadata.sourceKind === "paperclip_bundled"` and the canonical `paperclipai/paperclip/` key namespace as immutable, consistent with the existing `editable: false` treatment.

### 4. Optional: contract compliance surfacing

Company dashboard counts: delegated lanes with/without contracts, preflight blocks, QA contract failures. Cheap once (1) parses contracts server-side; feeds the `paperclip-company-audit` skill with hard numbers.

## Non-goals

- No `scope: root` schema migration — `sourceKind: "paperclip_bundled"` already provides root semantics (auto-inherited, read-only, required-on-sync, self-healing).
- No restriction of executor thread access — shared threads stay; the contract becomes the primary context, not the only one.

## Acceptance

- Agent delegation without a valid contract is rejected (enforce mode) or logged (warn mode).
- Execution-lane wake payloads carry the contract. (Shipped)
- Bundled skills cannot be deleted via the API. (Shipped)
- Existing tests pass; new tests cover contract validation warnings and the delete guard.
