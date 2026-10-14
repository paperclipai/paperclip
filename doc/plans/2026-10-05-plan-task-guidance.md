# Planning guidance reduction — 5 October 2026

Status: implementation and eval preparation; no live result yet.

## Decision and scope

Shorten the runtime plan-to-tasks skill and the bundled task-planning skill together.
Preserve skill identities, installed-version behavior, automatic accepted-plan
selection, authorization, and native/legacy mechanics. Remove the duplicated
operational-skill pointer. Do not merge without the human's authorization.

Base: `72ff3a9f27e581a27acb49771e8658bbb0bbaa47`. Prior work on PR #15218 and
its separate checklist remains untouched.

## Bounded comparison

Four ordinary execution scenarios: cohesive work; independent specialist outputs;
a real prerequisite between specialists; an independent adverse review.
Compare current, short, and disabled planning skills using public company-copy creation
and selection APIs in isolated companies. Archived current skill bytes come from
the base above. The disabled variant is an unassigned-selection ablation (the library remains discoverable), not a production
removal or an accepted-plan continuation test. Other instructions, tools, models,
permissions, fixtures, graders, budgets, and deadlines stay matched.

Initial scope: native Codex default profile, local, 12 cells, one attempt each,
500-cent company and per-agent hard stops, at most eight total run records per
cell, including coordination wakes. One exact pilot cell precedes the remaining
selection. No automatic retries or outcome rerolls. User authorization for paid
runs persists. Extra profiles/repetitions are not part of this initial comparison.

Judge independently saved results, authorship, child boundaries, dependency order,
review delivery, and parent completion. Retain all run records, failures, missing
evidence, source/fixture hashes, skill selections and served bytes, screenshots,
usage and billing coverage. Byte/word reductions are not token or cost savings.
Skill availability is not proof that a model read or cognitively used a skill.

Run credential-free source, catalog, type and grader calibration checks before
providers. Preserve positive, plausible wrong, and missing-evidence calibration.
Report exact scenario pairs rather than equal aggregate totals. Short guidance is
eligible only if the retained comparison supports it; inconclusive evidence stays
explicit. Automatic removal and existing installed copies need separate migration
and continuation qualification before a deletion recommendation can be shipped.

## Credential-free admission

- Product E2E TypeScript compilation: pass.
- Product E2E support: 1,286 Vitest tests and 128 Node checks pass.
- Catalog discovery: twelve explicit local Codex cells; excluded from `--all`.
- Archived source hashes: conversion `08cb036df0e05b1d704dc0cd547c4e37b73078597c072a85ff982a2bb9b3a370`; planning `9c52a44a30ec8d306119da51bf298e9e3e6c382a9a9559ffd3054bf5e0c75f36`. Both match the named base Git blobs exactly.
- Generated capability inventory and catalog are synchronized.
- No provider call has started. Live outcomes remain unqualified.

Source review found two fixture defects before provider execution: bundled and
catalog skills cannot be edited, and deleted core skills are automatically
restored. Campaign `37399550253` at `843238f43cb266f6ca0bc9d255881558ffd2eb71`
was cancelled; its paid-cell step was skipped, with zero provider runs and no
behavioral grade. Corrected setup creates editable, byte-identical company copies
and varies their explicit selection. No bundled deletion or in-place edit occurs.

Corrected fixture admission: all three current/short/unassigned variants pass real
company-skill creation, content readback and native-agent selection APIs against
a disposable PostgreSQL database. No heartbeat run rows were created. The
evaluator's 35 positive/wrong/missing-evidence checks pass, including rejection
of a bare issue-ID URL without the issues route. Product E2E typecheck passes.
Initial local DB checks were skipped until the dependency's missing library
symlinks were restored with its supplied postinstall script; skipped checks were
not counted as passes.

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

Repository checks at the previous source: full typecheck and build pass. Local
full tests: 9,591 pass, 5,796 skip and one unchanged macOS real-Git streaming test
hits its five-minute deadline; an isolated check also fails. Preserve this
limitation. Normal CI found a different, exact cause: truncated random fixture
company prefixes collided in chat integration setup. An initial per-suite counter fixed within-run collisions but review found that
its values repeat against an external database on subsequent runs. The corrected
prefix contains the complete company UUID, with no truncation; distinct company
IDs therefore produce distinct prefixes within and across runs. All five affected
native-modal variants pass locally (1,058 unrelated cases filtered). This is a
test-only repair; the measured planning fixture and production guidance remain
frozen at `8538cfce4c2defdedc2efba7519bcfce880c4e00`.
