# Bookforge Level 3 recurring-failure issue template

Use this template for recurring Bookforge generation, quality, cost, state, or export failures that should enter the Paperclip engineering workflow.

## Defect codes

Use exactly one primary defect code, and optional secondary codes only when needed.

- ARCH_JSON_SCHEMA — Architect output is invalid JSON, violates schema, or requires repeated repair.
- ARCH_ENRICHMENT_FLAVOR — beat plan exists but enrichment/flavor fields are empty, generic, or not improved by injection pass.
- MODEL_ROUTING_WASTE — paid fallback, retry, or model route spends extra money without clear gain.
- DEV_AUDIT_SCHEMA — developmental audit / critic output is invalid or needs schema repair.
- EDITOR_TRUNCATION_WORD_FLOOR — editor truncates below floor, removes beats, or returns a rejected edit.
- HUMAN_RHYTHM_AI_PROSE — human-rhythm guard detects clustered AI markers or residual prose risk.
- BEAT_VALIDATOR_NOISE — Beat Validator gives noisy, contradictory, uncited, or false-positive/false-negative output.
- WORKER_AUTO_ADVANCE — worker continues into the next chapter/phase after a one-chapter run should stop.
- STATE_CANON_TARGET_MISMATCH — queue, worker, approved target, canon memory, project, or chapter state disagree.
- MANUSCRIPT_STORY_QUALITY — story, canon, POV, pacing, reveal, or genre-plausibility problem not fully captured by schema.
- EXPORT_PUBLISHING_READINESS — EPUB/manuscript package, metadata, formatting, validation, or Kindle readiness failure.

## Status workflow

Canonical path:

observation_backlog -> triage_needed -> ready_for_engineering -> in_progress -> verification_needed -> learning_needed -> steward_review -> done

Branch statuses:

- blocked_safety — requested action would start/resume Bookforge, mutate live state, spend model money, wake broad agents, expose secrets, or change autonomy without approval.
- blocked_runtime — needed runtime/API/test environment is unavailable or unsafe.
- superseded_duplicate — issue repeats a canonical issue; add evidence to the canonical issue instead.

## Routing table

| Defect code | Primary owner | Support owner | Inspector verification |
| --- | --- | --- | --- |
| ARCH_JSON_SCHEMA | Bookforge Forgewright | Bookforge Scribe | Required for parser/schema/fallback acceptance changes |
| ARCH_ENRICHMENT_FLAVOR | Bookforge Scribe | Bookforge Forgewright | Required for prompt thresholds, fixtures, detectors, or gates |
| MODEL_ROUTING_WASTE | Bookforge Treasurer | Bookforge Forgewright | Required for routing, retry, price, model ban/allow, or budget changes |
| DEV_AUDIT_SCHEMA | Bookforge Forgewright | Bookforge Scribe | Required for audit schema, repair, critic gate, or validator changes |
| EDITOR_TRUNCATION_WORD_FLOOR | Bookforge Scribe | Bookforge Forgewright | Required for word-floor or edit acceptance/rejection changes |
| HUMAN_RHYTHM_AI_PROSE | Bookforge Scribe | Bookforge Inspector | Required for detector, cleanup, prompt, rubric, or acceptance changes |
| BEAT_VALIDATOR_NOISE | Bookforge Inspector | Bookforge Scribe | Always required |
| WORKER_AUTO_ADVANCE | Bookforge Forgewright | Bookforge Watchman read-only | Always required |
| STATE_CANON_TARGET_MISMATCH | Bookforge Archivist | Bookforge Forgewright | Always required |
| MANUSCRIPT_STORY_QUALITY | Bookforge Scribe | Bookforge Publisher near export | Required for gate changes or promoted/final decisions |
| EXPORT_PUBLISHING_READINESS | Bookforge Publisher | Bookforge Inspector | Always required |

## Issue title format

[DEFECT_CODE] Short failure summary — project/chapter or subsystem

Example:

[ARCH_ENRICHMENT_FLAVOR] Architect enrichment stayed empty on 12/12 Ch21 beats — the_widow_in_room_twelve ch21

## Required fields

Defect code:
Severity: blocker / high / medium / low
Project/book:
Chapter/subsystem:
Source observation:
Evidence summary:
Exact files/artifacts inspected:
User-visible impact:
Cost/spend impact:
Safety impact:
Suspected root cause:
Primary owner:
Support owner, if any:
Inspector verification required: yes/no, with reason
Allowed work:
Forbidden work:
Acceptance criteria:
Verification plan:
Learning artifact required:
Duplicate/superseded link, if any:
Steward approval needed before runtime action: yes/no, with reason

## Standard safety constraints

Paste these constraints into any Bookforge Level 3 engineering issue unless the user explicitly approves a narrower exception:

- Do not start, resume, or continue Bookforge generation.
- Do not spend Bookforge generation/model money.
- Do not mutate queue, worker, database, phase state, canon state, promoted chapters, manuscript files, backups, exports, budgets, model routing, heartbeat, runtime monitor, permissions, or org chart.
- Do not wake broad departments.
- Use one issue, one owner, one narrow defect class unless Steward explicitly approves more.
- Keep secrets redacted.
- Run focused no-token tests or explain why no test is possible.
- Report Paperclip live-runs and Bookforge running/spending status at completion.

## Suggested labels

Core labels:

- bookforge-recurring-failure
- no-bookforge-start
- no-live-state-mutation
- inspector-required or inspector-optional

Defect labels:

- defect:ARCH_JSON_SCHEMA
- defect:ARCH_ENRICHMENT_FLAVOR
- defect:MODEL_ROUTING_WASTE
- defect:DEV_AUDIT_SCHEMA
- defect:EDITOR_TRUNCATION_WORD_FLOOR
- defect:HUMAN_RHYTHM_AI_PROSE
- defect:BEAT_VALIDATOR_NOISE
- defect:WORKER_AUTO_ADVANCE
- defect:STATE_CANON_TARGET_MISMATCH
- defect:MANUSCRIPT_STORY_QUALITY
- defect:EXPORT_PUBLISHING_READINESS

Owner labels:

- owner:forgewright
- owner:scribe
- owner:inspector
- owner:treasurer
- owner:archivist
- owner:publisher
- owner:watchman-readonly

Severity labels:

- severity:blocker
- severity:high
- severity:medium
- severity:low

Workflow labels:

- workflow:observation_backlog
- workflow:triage_needed
- workflow:ready_for_engineering
- workflow:verification_needed
- workflow:learning_needed
- workflow:steward_review
- blocked:safety
- blocked:runtime
- superseded:duplicate

## Dry-run example: Chapter 21 workflow cluster

Title:
[ARCH_ENRICHMENT_FLAVOR] Architect enrichment stayed empty on 12/12 Ch21 beats — the_widow_in_room_twelve ch21

Defect code:
ARCH_ENRICHMENT_FLAVOR

Secondary codes:
ARCH_JSON_SCHEMA, MODEL_ROUTING_WASTE, DEV_AUDIT_SCHEMA, EDITOR_TRUNCATION_WORD_FLOOR, HUMAN_RHYTHM_AI_PROSE, BEAT_VALIDATOR_NOISE, WORKER_AUTO_ADVANCE

Severity:
high

Project/book:
the_widow_in_room_twelve

Chapter/subsystem:
Chapter 21 / Architect + downstream quality pipeline

Source observation:
Chapter 21 activity log and Steward report BOO-119 / BOO-125.

Evidence summary:
Architect primary failed JSON validation, paid fallback was used, enrichment stayed absent on 12/12 beats, flavor injection did not improve enrichment, downstream audit/editor/rhythm/validator gates had to compensate, and worker briefly auto-entered Chapter 22 before manual stop.

User-visible impact:
The chapter passed, but the creation process was noisy, expensive, and too dependent on late-stage repair nets.

Cost/spend impact:
Paid fallback and repair calls increased chapter cost.

Safety impact:
Worker auto-advance is a spend-control risk; no further Bookforge generation may be started by this issue.

Primary owner:
Bookforge Scribe for enrichment/prompt weakness.

Support owner:
Bookforge Forgewright for schema/field retention and worker stop controls.

Inspector verification required:
yes, because validator/gate reliability and stop-after-one-chapter behavior are involved.

Allowed work:
Inspect prompts, tests, logs, artifacts, and non-live code. Draft a narrow fix plan or non-live prompt/test change.

Forbidden work:
Starting Bookforge, clearing holds, promoting chapters, mutating queue/state/canon/manuscript/export/model-routing/budget/runtime monitor, or waking other agents.

Acceptance criteria:
A narrow engineering issue is created for either Architect enrichment reliability or worker auto-advance, not both, with tests and no Bookforge start.

Verification plan:
Focused no-token tests; inspect git diff; verify Bookforge stopped and Paperclip live-runs empty.

Learning artifact required:
Update Paperclip/Bookforge Level 3 triage reference with the final verified lesson.

Steward approval needed before runtime action:
yes.
