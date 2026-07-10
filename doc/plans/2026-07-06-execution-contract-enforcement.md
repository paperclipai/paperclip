# Plan: Server-Side Execution Contract Enforcement (Stage 2)

Date: 2026-07-06
Status: shipped for agent-created child execution lanes (V2 hidden storage/transport/UI live; hard 422 enforcement live for agent-created child issues; comments and human-created issues remain natural/intake-first)

## Context

Stage 1 added execution-contract rules to the bundled `paperclip` skill (`references/execution-contract.md`): managers include a contract with every delegated child issue, executors run preflight, QA reviews against the contract. This is instruction-level enforcement — agents follow it because the skill tells them to, but the server does not verify required contract presence.

V2 added hidden contract storage and transport: `issues.execution_contract`, API `executionContract`, issue detail/heartbeat-context/wake payload delivery, legacy description extraction, and a collapsed UI audit panel.

Stage 2 makes the contract structural, replicating the property that makes isolated-subagent handoffs (e.g. Claude Code's Agent tool) reliable: **the handoff artifact is the executor's primary starting context, and its presence is mechanically enforced.**

## Shipped / Proposed Changes

### 1. Contract validation on delegation

Shipped in enforce mode. In the issue service, when an **agent** creates an issue with `parentId` set:

- Read the hidden `executionContract` field. Legacy `## Execution Contract` description blocks may still be extracted for compatibility, but new delegation validation should target the JSON field.
- Validate required fields: `schemaVersion`, `contractType`, `taskType`, `core.objective`, `core.why`, non-empty `core.sourceOfTruth`, non-empty `core.acceptanceChecks`, `core.handoffNotes.managerReasoning`.
- Parse the API envelope with explicit types for canonical fields while keeping unknown extension fields forward-compatible. Direct service callers receive the same structural validation as HTTP callers.
- Enforce-mode behavior: reject with `422` and a field-level error message when missing/invalid, mirroring the existing two-level topology enforcement (which already rejects grandchildren and >10 lanes — precedent for hard orchestration gates in this service).
- Revalidate agent-origin child contracts when they are edited. Board acceptance of an agent-authored `suggest_tasks` proposal preserves the proposing agent as the child origin, so acceptance cannot downgrade the handoff into the human-created exemption.
- Store `revision: 1` on new contracts. Before execution begins, each changed contract advances exactly one revision and records `supersedesRevision`; clients may omit revision metadata or echo the current revision, and compare-and-swap persistence rejects stale/concurrent revision races. Once an issue has started or left the pre-execution statuses, its contract is frozen and a replacement issue is required for a superseding handoff.
- Human-created issues are exempt (agents reconstruct contracts for human requests, per the skill).
- Future rollback flag, if needed: per-company setting (`instance_settings` or company metadata) `requireExecutionContracts: enforce | warn | off`. The current server behavior is hard enforcement for agent-created child lanes.

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

- Agent delegation without a valid contract is rejected.
- Execution-lane wake payloads carry the contract. (Shipped)
- Bundled skills cannot be deleted via the API. (Shipped)
- Existing tests pass; new tests cover contract rejection, human exemptions, legacy extraction, and the delete guard.
