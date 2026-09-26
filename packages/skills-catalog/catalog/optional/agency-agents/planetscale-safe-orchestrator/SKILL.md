---
name: "planetscale-safe-orchestrator"
description: "Master skill that runs the full PlanetScale safe best-practices assessment — inventory, engine review, Insights, Traffic Control, webhooks, schema recommendations, codebase instrumentation, and agent operating model — then produces a unified recommendations report."
disable-model-invocation: true
key: "paperclipai/optional/agency-agents/planetscale-safe-orchestrator"
recommendedForRoles:
  - "engineer"
tags:
  - "agency-agents"
  - "engineer"
  - "planetscale"
  - "safe"
  - "orchestrator"
defaultInstall: false
---
# PlanetScale safe orchestrator (master skill)

## Purpose

Run the complete PlanetScale safe best-practices skill pack end to end. Load and execute each sub-skill in order, accumulate evidence, and produce one unified recommendations report. The first pass is assessment-only.

## Non-negotiable safety contract

Default to read-only.

You may inspect configuration, branches, query telemetry, recommendations, webhooks, roles, backups, traffic budgets, and repository code. You must not mutate PlanetScale, the database, the repository, the network posture, credentials, schema, production traffic controls, or automation endpoints without explicit approval of a named change set.

Class C/D/E mutations require approval per `../11-change-gates-and-approval-contract/SKILL.md`. When in doubt, stop and add to the proposed change set instead of executing.

One exception exists: if the operator explicitly acknowledges the risk and names a scope per `../13-autonomous-execution-mode/SKILL.md`, execution proceeds autonomously under that skill's status and halt discipline instead of stopping for per-change approval. The assessment phases below are identical either way.

Sub-skills are sibling folders next to this skill (for example `../01-readonly-inventory/SKILL.md`). Some installers rename skill folders to their frontmatter `name` (for example `planetscale-readonly-inventory` instead of `01-readonly-inventory`); if a referenced numbered path does not exist, locate the sibling skill whose frontmatter `name` matches and use it instead.

Ground all CLI and API usage in the official documentation rather than guessing: the docs index is at https://planetscale.com/docs/llms.txt (append `.md` to any docs URL for the markdown version) and the API reference is https://planetscale.com/docs/openapi.yaml. When a command or endpoint fails, check the docs for the correct form before recording an evidence gap. Tooling and access failures belong in the internal run log, never in the customer report.

## Before you start

1. Read this file completely.
2. Copy the progress checklist below into your working notes and update it as you go.
3. Collect inputs (ask or infer from `AGENTS.md`, MCP context, environment, repository):

   - Organization slug
   - Database name
   - Branch name
   - Engine: PlanetScale Vitess or PlanetScale Postgres
   - Production branch or branches
   - Connected application repository path, if available
   - Application language, framework, ORM, query builder, connection pooling
   - Operator tolerance: report-only, PR-generation, branch-only migrations, or supervised production apply

If inputs are missing, continue with discovery. Do not block on completeness.

## Progress checklist

Copy and track:

```
Master assessment progress:
- [ ] Phase 0: Safety contract loaded
- [ ] Phase 1: Read-only inventory
- [ ] Phase 2: Engine safety review (Vitess OR Postgres)
- [ ] Phase 3: Query Insights and tags
- [ ] Phase 4: Traffic Control (Postgres only — skip for Vitess)
- [ ] Phase 5: Webhook automation
- [ ] Phase 6: Schema recommendations agent loop
- [ ] Phase 7: Codebase SQLCommenter instrumentation
- [ ] Phase 8: MCP agent operating model
- [ ] Phase 9: Best-practices matrix coverage check
- [ ] Phase 10: Unified customer report
- [ ] Phase 11: Change gates verified — stop, no mutations
```

## Interface preference order

1. PlanetScale MCP insights-only server — autonomous analysis without query execution
2. Full PlanetScale MCP with read-only scope — schema or limited read queries
3. `pscale` CLI and `pscale api` — structured inventory and exact API state
4. Repository inspection — codebase analysis and instrumentation recommendations
5. Direct SQL — read-only introspection only when operator grants database read access

The operator's stated interface constraint overrides this order. If the
run is restricted to specific interfaces (for example CLI-only), use those
interfaces; this is not a conflict and needs no workaround or note in the
customer report beyond the Scope section's interfaces line.

## Execution plan

For each phase: **read the skill file**, follow its instructions, capture its required output, and carry findings forward. Do not skip phases unless the checklist says to skip.

### Phase 0 — Safety contract

Read: `../11-change-gates-and-approval-contract/SKILL.md`

Internalize operation classes A–E. All later phases operate under Class A unless the operator explicitly approves a named change.

### Phase 1 — Read-only inventory

Read and execute: `../01-readonly-inventory/SKILL.md`

Deliverables to carry forward:

- Inventory table with evidence (source, path/command, timestamp, confidence)
- Missing evidence table
- Risk flags
- Confirmed engine (Vitess or Postgres)
- Branch topology and production branch

If engine is still unknown after inventory, determine it before Phase 2.

### Phase 2 — Engine safety review

Run exactly one:

| Engine | Skill file |
|--------|------------|
| Vitess | `../02-vitess-safety-review/SKILL.md` |
| Postgres | `../03-postgres-safety-review/SKILL.md` |

Deliverables: engine-specific safety gaps, workflow gaps, and proposed changes requiring approval.

### Phase 3 — Query Insights and tags

Read and execute: `../04-query-insights-and-tags/SKILL.md`

Deliverables: query risk table, tag coverage table, bad/high-cardinality tags, recommended tag schema, candidate Traffic Control slices, candidate schema and code changes.

### Phase 4 — Traffic Control (Postgres only)

**Skip this phase for Vitess.** Mark checklist item complete with note "N/A — Vitess".

For Postgres, read and execute: `../05-traffic-control-recommendations/SKILL.md`

Deliverables: proposed budgets (name, mode, traffic slice, rule type, limits rationale, test/rollback plan).

If query tags are weak, note "tagging first" per that skill and defer enforce-mode recommendations.

### Phase 5 — Webhook automation

Read and execute: `../06-webhook-automation-recommendations/SKILL.md`

Deliverables: webhook inventory, missing subscriptions, destination quality review, automation opportunities, unsafe automation risks.

### Phase 6 — Schema recommendations agent loop

Read and execute: `../07-schema-recommendations-agent-loop/SKILL.md`

Deliverables: per-recommendation triage (type, severity, evidence, safe implementation path, validation/rollback plan).

### Phase 7 — Codebase SQLCommenter instrumentation

Read and execute: `../08-codebase-sqlcommenter-instrumentation/SKILL.md`

Skip only if no repository is available. Note "no repository reviewed" in the final report.

Deliverables: detected stack, current tagging state, recommended package/path, proposed tag schema, files likely to change.

### Phase 8 — MCP agent operating model

Read and execute: `../09-mcp-agent-operating-model/SKILL.md`

Deliverables: recommended MCP server choice, AGENTS.md additions, allowed/disallowed autonomous work, proposed agent loops.

### Phase 9 — Best-practices matrix coverage check

Read and execute: `../12-best-practices-matrix/SKILL.md`

Cross-check every matrix item against Phases 1–8 findings. For each item record:

- Applies: yes / no / unknown
- Current state
- Gap
- Recommendation ID (see ID scheme below)
- Approval requirement

Fill gaps: if a matrix item was not covered by earlier phases, gather missing evidence now (read-only only).

### Phase 10 — Unified customer report

Read and execute: `../10-customer-report-template/SKILL.md`

Synthesize **all** phase deliverables into one report. Do not dump raw phase outputs — merge, deduplicate, and rank by impact.

#### Recommendation ID scheme

| Prefix | Domain |
|--------|--------|
| `OBS-*` | Insights and query tags |
| `VIT-*` | Vitess safety and deploy workflow |
| `PG-*` | Postgres roles, pg_strict, Traffic Control, PITR, network |
| `WEB-*` | Webhooks and automation |
| `APP-*` | Repository instrumentation |
| `AGENT-*` | MCP and agent workflows |

Assign stable IDs across the report. Reference the same IDs in the proposed change set.

#### Ranking guidance

Order recommendations by:

1. Production safety and availability risk (highest first)
2. Observability gaps blocking diagnosis or Traffic Control
3. Automation that reduces mean time to detect/respond
4. Performance and schema improvements with clear evidence

### Phase 11 — Stop gate

Re-read: `../11-change-gates-and-approval-contract/SKILL.md`

Verify:

- No Class C/D/E actions were taken
- Every proposed mutation has an ID, target, interface, effect, risk, rollback, and test plan
- Report ends with the required final sentence

**Stop.** Do not apply changes — unless a valid autonomous-mode acknowledgment (per `../13-autonomous-execution-mode/SKILL.md`) accompanied the request, in which case present the report and the execution plan, then continue directly into execution under that skill.

## Required final report structure

Use the template in `../10-customer-report-template/SKILL.md`. Minimum sections:

1. **Scope** — org, database, branches, engine, repository, interfaces, time window; changes applied: none
2. **Executive summary** — 3–7 bullets on highest-risk gaps and highest-value improvements
3. **Current state** — database topology, safety workflow, observability, automation, repository instrumentation (with evidence)
4. **Recommendations** — ranked table with IDs, target, benefit, risk, approval needed, test first, evidence
5. **Proposed change set requiring approval** — every Class C/D item with exact change, interface, rollback, production impact
6. **Changes intentionally not applied** — explicit list of what was not changed
7. **Evidence appendix** — source, command/path, timestamp, value, notes
8. **Final required sentence** (verbatim):

   > No changes have been applied. Approve specific change IDs before any mutation.

## Handling partial runs

If MCP, CLI, API, or repository access is unavailable:

- Continue with available interfaces
- Record missing evidence in the report
- Lower confidence on affected recommendations
- Do not invent state — mark unknown

## After the report

Two paths into execution:

**Per-change approval.** The operator approves specific change IDs:

1. Re-read `../11-change-gates-and-approval-contract/SKILL.md`
2. Execute only the named IDs
3. Produce the post-execution report defined in that skill

**Autonomous mode.** The operator explicitly acknowledges the risk with a named scope ("I accept the risk — apply all report recommendations to storefront-demo, production included"):

1. Read `../13-autonomous-execution-mode/SKILL.md` and validate the acknowledgment against its activation contract
2. Present the dependency-ordered execution plan, then execute end to end with continuous status, per-step verification, and the halt rules from that skill
3. Produce the run summary and run log

Never interpret "apply best practices", "fix everything", or "go ahead" as either approval or risk acknowledgment.

## Quick invocation

When the user says "run the full assessment" or "run all PlanetScale best-practices skills":

1. Load this skill
2. Run Phases 0–11 in order
3. Return the unified report
4. Stop
