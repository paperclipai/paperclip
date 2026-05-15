# Paperclip Skill Tightening Plan

## Status

Deferred follow-up. Do not include in the current token-optimization PR beyond documenting the plan.

## Why This Is Deferred

The `paperclip` skill is part of the critical control-plane safety surface. Tightening it may reduce fresh-session token use, but it also carries prompt-regression risk. We do not yet have evals that would let us safely prove behavior preservation across assignment handling, checkout rules, comment etiquette, approval workflows, and escalation paths.

The current PR should ship the lower-risk infrastructure wins first:

- telemetry normalization
- safe session reuse
- incremental issue/comment context
- bootstrap versus heartbeat prompt separation
- Codex worktree isolation

## Current Problem

Fresh runs still spend substantial input tokens even after the context-path fixes. The remaining large startup cost appears to come from loading the full `paperclip` skill and related instruction surface into context at run start.

The skill currently mixes three kinds of content in one file:

- hot-path heartbeat procedure used on nearly every run
- critical policy and safety invariants
- rare workflow/reference material that most runs do not need

That structure is safe but expensive.

## Goals

- reduce first-run instruction tokens without weakening agent safety
- preserve all current Paperclip control-plane capabilities
- keep common heartbeat behavior explicit and easy for agents to follow
- move rare workflows and reference material out of the hot path
- create a structure that can later be evaluated systematically

## Non-Goals

- changing Paperclip API semantics
- removing required governance rules
- deleting rare workflows
- changing agent defaults in the current PR

## Recommended Direction

### 1. Split Hot Path From Lookup Material

Restructure the skill into:

- an always-loaded core section for the common heartbeat loop
- on-demand material for infrequent workflows and deep reference

The core should cover only what is needed on nearly every wake:

- auth and required headers
- inbox-first assignment retrieval
- mandatory checkout behavior
- `heartbeat-context` first
- incremental comment retrieval rules
- mention/self-assign exception
- blocked-task dedup
- status/comment/release expectations before exit

### 2. Normalize The Skill Around One Canonical Procedure

The same rules are currently expressed multiple times across:

- heartbeat steps
- critical rules
- endpoint reference
- workflow examples

Refactor so each operational fact has one primary home:

- procedure
- invariant list
- appendix/reference

This reduces prompt weight and lowers the chance of internal instruction drift.

### 3. Compress Prose Into High-Signal Instruction Forms

Rewrite the hot path using compact operational forms:

- short ordered checklist
- flat invariant list
- minimal examples only where ambiguity would be risky

Reduce:

- narrative explanation
- repeated warnings already covered elsewhere
- large example payloads for common operations
- long endpoint matrices in the main body

### 4. Move Rare Workflows Behind Explicit Triggers

These workflows should remain available but should not dominate fresh-run context:

- OpenClaw invite flow
- project setup flow
- planning `<plan/>` writeback flow
- instructions-path update flow
- detailed link-formatting examples

Recommended approach:

- keep a short pointer in the main skill
- move detailed procedures into sibling skills or referenced docs that agents read only when needed

### 5. Separate Policy From Reference

The skill should distinguish:

- mandatory operating rules
- endpoint lookup/reference
- business-process playbooks

That separation makes it easier to evaluate prompt changes later and lets adapters or orchestration choose what must always be loaded.

## Proposed Target Structure

1. Purpose and authentication
2. Compact heartbeat procedure
3. Hard invariants
4. Required comment/update style
5. Triggered workflow index
6. Appendix/reference

## Rollout Plan

### Phase 1. Inventory And Measure

- annotate the current skill by section and estimate token weight
- identify which sections are truly hot-path versus rare
- capture representative runs to compare before/after prompt size and behavior

### Phase 2. Structural Refactor Without Semantic Changes

- rewrite the main skill into the target structure
- preserve all existing rules and capabilities
- move rare workflow details into referenced companion material
- keep wording changes conservative

### Phase 3. Validate Against Real Scenarios

Run scenario checks for:

- normal assigned heartbeat
- comment-triggered wake
- blocked-task dedup behavior
- approval-resolution wake
- delegation/subtask creation
- board handoff back to user
- plan-request handling

### Phase 4. Decide Default Loading Strategy

After validation, decide whether:

- the entire main skill still loads by default, or
- only the compact core loads by default and rare sections are fetched on demand

Do not change this loading policy without validation.

## Risks

- prompt degradation on control-plane safety rules
- agents forgetting rare but important workflows
- accidental removal of repeated wording that was carrying useful behavior
- introducing ambiguous instruction precedence between the core skill and companion materials

## Preconditions Before Implementation

- define acceptance scenarios for control-plane correctness
- add at least lightweight eval or scripted scenario coverage for key Paperclip flows
- confirm how adapter/bootstrap layering should load skill content versus references

## Success Criteria

- materially lower first-run input tokens for Paperclip-coordinated agents
- no regression in checkout discipline, issue updates, blocked handling, or delegation
- no increase in malformed API usage or ownership mistakes
- agents still complete rare workflows correctly when explicitly asked
