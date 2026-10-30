# Planning guidance utility

`plan-task-guidance` is an explicit-only Product E2E suite. It runs the real UI,
public API, native Codex and saved task graph on four scenarios: one cohesive
order summary; two independent specialist approvals; a release depending on a
saved upstream result; and an independent adverse audit.

Each scenario compares current (archived from master
`72ff3a9f27e581a27acb49771e8658bbb0bbaa47`), short (checkout production files),
and disabled planning skills. The fixture creates editable company-owned copies through the public API,
preserving each source file byte-for-byte, then explicitly selects those copies
before any task starts. Bundled/catalog skills remain read-only. Both runtime plan conversion
and catalog task planning change together. All agents get the same treatment.
Disabled leaves those copies unassigned, with an empty explicit skill selection.
The company library and automatically restored core inventory remain available;
this is a selection ablation, not proof that a determined agent cannot discover
unassigned guidance.
The eval does not exercise automatic accepted-plan selection or installed-skill
migration, and cannot by itself qualify deleting that wiring.

The business prompts do not prescribe task counts or particular tools. Enabled
variants append explicit references to the two assigned runtime skill names; the
unassigned control appends none. This measures explicitly invoked guidance, not
automatic discovery. A separate exposure gate requires the initial lead run to
submit exactly those native skill inputs, bound to the immutable SKILL.md file
digests, and records provider turn acceptance. The controller emits the submission
receipt before a provider turn ID exists: this is a run-bound submission contract,
not a claimed provider call-ID join or proof of cognitive consumption. Native
protocol calibration separately verifies mapping into the isolated provider skill
directory. Missing or wrong exposure fails qualification even when the output
checks pass.

The scenario prompts do not prescribe task counts or particular tools. They do
specify which specialist is accountable and what business output is required.
The grader checks independent arithmetic, actual latest document revisions and
author/run attribution through exact document-ID/revision-number activity joins,
owned work items, prerequisite execution order, reviewer write boundaries, and
completion handoffs. It reports parallel scheduling opportunity separately from
correctness. No run can pass through an agent-authored self-assessment.

Twelve local cells, one attempt each, 12-minute cell deadline, 360-second provider
deadline, eight total run records, and 500-cent company/per-agent budget hard stops
bound the initial comparison. Coordination wakes count. Failed or missing evidence
stays failed. No automatic retries. The initial paid selection is one exact pilot,
then the eleven remaining cells only if fixture admission is sound. All cells use
the same native Codex model and production tool contracts. This is a bounded pilot,
not a cross-model reliability, speed, or cost claim.

```sh
pnpm test:e2e:runner:typecheck
pnpm test:e2e:runner:unit
pnpm test:e2e:runner -- --list --suite plan-task-guidance
pnpm test:e2e:runner -- --id plan-task-guidance.runner-codex.local.short-cohesive --max-parallel 1
```

Each attempt keeps `plan-task-source.json`, `plan-task-guidance.json`,
`plan-task-runs.json`, API state, screenshots and the existing run/accounting
reports. Selections and served hashes establish availability, not successful
skill invocation or cognitive consumption. Word/UTF-8 byte counts are exact file
measurements; provider context, token usage and billing coverage come from actual
retained run records. Cleanup, credential scanning and public projection use the
existing Product E2E pipeline. Do not publish raw sessions or hidden reasoning.

Setup attempt [37399550253](https://github.com/paperclipai/paperclip/actions/runs/37399550253)
on source `843238f43cb266f6ca0bc9d255881558ffd2eb71` was cancelled after source
review identified unsupported bundled edits and automatic core reinstallation.
The paid-cell step was skipped: zero provider runs and no behavioral grade.
The corrected fixture uses company copies and selection only.

The next setup campaign, [37401094799](https://github.com/paperclipai/paperclip/actions/runs/37401094799),
measured source `370e51d110836b942e5f90567d2bbe260bcc0f3a` using trusted workflow
revision `0e0b63e5a551388ac4601ed982b3e8f1c772f123` (workflow blob
`0600886144d3e22ea2e4a38329a79177882f3948`). It remains an original FAIL,
classified by the harness as `candidate_failure`. Inspection shows a browser
fixture error before task creation: the shared helper waited for the old Task
title field. `runIds`, the company run ledger, and planning observation are all
empty; no model executed. Cleanup passed. The billing summary's runCount=1 is
its minimum-one placeholder (`billing.ts`), not evidence of a provider run;
runtime/actual charges remain unmetered. No original result is regraded.

The corrected planning-only browser helper uses the current description composer,
explicitly selects the owner, and captures the public task-create response ID. A
real browser/server/database calibration creates the exact prompt/assignment with
paused non-provider agents, confirms zero run rows, and deletes its company. It
passes. Before any model execution, prompts also explicitly name the already
required result document key and exact JSON fields, avoiding an unstated oracle
format assumption. The legacy helper and production UI remain unchanged.
