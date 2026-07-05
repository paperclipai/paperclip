# Plan: Server-Side Execution Contract Enforcement (Stage 2)

Date: 2026-07-06
Status: proposed (stage 1 — skill-level contracts — shipped on branch `root-skills-governance`)

## Context

Stage 1 added execution-contract rules to the bundled `paperclip` skill (`references/execution-contract.md`): managers embed a contract in every delegated child issue, executors run preflight, QA reviews against the contract. This is instruction-level enforcement — agents follow it because the skill tells them to, but the server does not verify anything.

Stage 2 makes the contract structural, replicating the property that makes isolated-subagent handoffs (e.g. Claude Code's Agent tool) reliable: **the handoff artifact is the executor's primary starting context, and its presence is mechanically enforced.**

## Proposed changes

### 1. Contract validation on delegation

In the issue service (`server/src/services/issues.ts`), when an **agent** creates an issue with `parentId` set:

- Parse the description for a `## Execution Contract` section containing a fenced JSON block (or an issue document with key `contract` created in the same flow).
- Validate required fields: `objective`, `why`, `task_type`, non-empty `source_of_truth`, non-empty `acceptance_checks`, `handoff_notes.manager_reasoning`.
- Reject with `422` and a field-level error message when missing/invalid, mirroring the existing two-level topology enforcement (which already rejects grandchildren and >10 lanes — precedent for hard orchestration gates in this service).
- Human-created issues are exempt (agents reconstruct contracts for human requests, per the skill).
- Rollout flag: per-company setting (`instance_settings` or company metadata) `requireExecutionContracts: warn | enforce | off`, default `warn` initially; flip to `enforce` after contract adoption is visible in real issues.

### 2. Contract-driven wake payloads

`PAPERCLIP_WAKE_PAYLOAD_JSON` (and `heartbeat-context`) already exist. Extend them to include the parsed contract as a first-class field for execution-lane wakes, so the executor's starting context IS the contract rather than "go read the thread". QA-stage wakes include the same contract for mechanical comparison.

### 3. Protected-skill hardening (small)

`companySkillService.deleteSkill()` currently allows deleting `paperclip_bundled` skills (self-heal masks it until the next inventory refresh). Add an explicit guard: reject deletion of skills whose metadata `sourceKind === "paperclip_bundled"` with a clear error. One conditional + test, consistent with the existing `editable: false` treatment.

### 4. Optional: contract compliance surfacing

Company dashboard counts: delegated lanes with/without contracts, preflight blocks, QA contract failures. Cheap once (1) parses contracts server-side; feeds the `paperclip-company-audit` skill with hard numbers.

## Non-goals

- No `scope: root` schema migration — `sourceKind: "paperclip_bundled"` already provides root semantics (auto-inherited, read-only, required-on-sync, self-healing).
- No restriction of executor thread access — shared threads stay; the contract becomes the primary context, not the only one.

## Acceptance

- Agent delegation without a valid contract is rejected (enforce mode) or logged (warn mode).
- Execution-lane wake payloads carry the contract.
- Bundled skills cannot be deleted via the API.
- Existing tests pass; new tests cover the 422 path, warn-mode logging, and the delete guard.
