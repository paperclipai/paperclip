# Paperclip Idea Combinations

This folder synthesizes the 64 individual ideas in `../` into **13 combined features**. Each
combination merges ideas that converge on the *same seam, data model, or product surface* into one
coherent, higher-leverage feature — so they compose by construction instead of being built as
overlapping one-offs.

Each file states what it combines, the unified idea, why combining beats building separately, a
phasing plan, and three ratings: **difficulty**, **estimated time**, and **importance (1–10)**.

## The combinations

| # | Combination | Merges ideas | Difficulty | Est. time | Importance |
|---|-------------|--------------|-----------|-----------|-----------|
| 01 | [Unified Runtime Control Plane](combo-01-runtime-control-plane.md) | 001, 002, 005, 014, 024, 035, 061, 042 | High | 6–9 wk | **9** |
| 02 | [Mixed-Economy Model & Provider Fabric](combo-02-model-economy-fabric.md) | 008, 012, 049, 041 | Med–High | 4–6 wk | **8** |
| 03 | [Autonomous Company Health Sentinel](combo-03-company-health-sentinel.md) | 003, 010, 026, 059, 044, 006, 031 | Med–High | 5–7 wk | **9** |
| 04 | [Autonomous CFO Suite](combo-04-cfo-suite.md) | 013, 019, 030, 037, 055, 063 | Med–High | 5–7 wk | **8** |
| 05 | [Operator Review & Approval Cockpit](combo-05-review-cockpit.md) | 016, 017, 027, 029, 038, (033) | Medium | 4–6 wk | **9** |
| 06 | [Agent CI/CD & Evidence-Based Quality](combo-06-agent-ci.md) | 011, 032, 040, 046 | Med–High | 5–7 wk | **7** |
| 07 | [Self-Staffing & Self-Organizing Workforce](combo-07-self-staffing-org.md) | 048, 047, 025, 009, 052 | High | 6–9 wk | **7** |
| 08 | [Zero-Trust Security, Governance & Compliance](combo-08-zero-trust-governance.md) | 043, 020, 021, 022, 023, 034, 050 | High | 8–12 wk | **8** |
| 09 | [Resilience, DR & Incident Response](combo-09-resilience-recovery.md) | 015, 051, 057, 045, (014) | Med–High | 5–7 wk | **7** |
| 10 | [Day-One Adoption Kit](combo-10-day-one-adoption.md) | 039, 018, 004, 064, 058 | Medium | 4–6 wk | **8** |
| 11 | [Institutional Memory & Continuous Learning](combo-11-institutional-memory.md) | 060, 028, 056, (055, 057) | High | 7–10 wk | **7** |
| 12 | [Two-Way External Integration Fabric](combo-12-external-integration-fabric.md) | 062, 036, (030) | Medium | 3–5 wk | **6** |
| 13 | [Governed Cross-Company Fabric](combo-13-cross-company-fabric.md) | 054, 007, 053, (033) | High | 8–12 wk | **6** |

Parenthesized ideas are *referenced/woven in* by a combination whose primary home is elsewhere.

## Source-idea → combination map

Every one of the 64 ideas lands in exactly one **primary** combination (cross-references noted in the
files):

| Idea | Primary combo | Idea | Primary combo |
|------|---------------|------|---------------|
| 001 Fleet Concurrency Governor | 01 | 033 Stakeholder Transparency Page | 05 (→13) |
| 002 Predictive Budget Breaker | 01 | 034 Data Retention & PII | 08 |
| 003 Diminishing-Returns Detector | 03 | 035 Adaptive Heartbeat Cadence | 01 |
| 004 Company Dry-Run Estimator | 10 | 036 Outbound Webhooks | 12 |
| 005 Spend-Schedule / Quiet Hours | 01 | 037 Prompt-Cache Optimization | 04 |
| 006 Org Bottleneck Heatmap | 03 | 038 Approval Delegation & Coverage | 05 |
| 007 Holding Company | 13 | 039 Guided Onboarding & Demo | 10 |
| 008 Local LLM Adapter | 02 | 040 Operator-Owned Training Dataset | 06 |
| 009 Agent Probation / Trust Ramp | 07 | 041 Host Resource-Aware Scheduling | 02 |
| 010 Blocker-Graph Deadlock Detector | 03 | 042 Workspace Conflict Coordination | 01 |
| 011 Eval-Gated Config Deploys | 06 | 043 Policy-as-Code Governance | 08 |
| 012 Provider Fallback Chains | 02 | 044 Agent Reliability SLOs | 03 (→07,09) |
| 013 Unit-Economics Dashboard | 04 | 045 Plugin Versioning/Rollback/Health | 09 |
| 014 Emergency Stop & Drain | 01 (→09) | 046 Skill Effectiveness Analytics | 06 |
| 015 Company Point-in-Time Rewind | 09 | 047 Role-Based Skill Auto-Provisioning | 07 |
| 016 Approval Triage & Batching | 05 | 048 Competency-Gated Job Postings | 07 |
| 017 Run Change-Review Surface | 05 | 049 Shared-Credential Fair-Share | 02 |
| 018 Company Blueprint Library | 10 | 050 Work-Product Security Scanning | 08 |
| 019 Token-Denominated Budgets | 04 | 051 DR Backup Verification | 09 |
| 020 Outbound Secret-Leak Scanning | 08 | 052 Org Restructuring Simulator | 07 |
| 021 Just-in-Time Secret Leasing | 08 | 053 Inter-Company Shared Services | 13 |
| 022 Per-Agent Egress Allowlist | 08 | 054 Company Mailbox | 13 |
| 023 Tamper-Evident Audit Log | 08 | 055 Estimate-vs-Actual Calibration | 04 (→11) |
| 024 Per-Run Resource Caps | 01 | 056 Business Experiment Framework | 11 |
| 025 Capability-Based Auto-Assignment | 07 | 057 Incident Management & On-Call | 09 (→11) |
| 026 Goal-Drift Alignment Auditor | 03 | 058 Work Templates & DoD | 10 (→05) |
| 027 Mobile Push & Fast Approvals | 05 | 059 Goal Decomposition Quality | 03 |
| 028 Agent Shift-Handoff Briefings | 11 | 060 Knowledge System | 11 |
| 029 Scheduled Operator Digest | 05 | 061 WIP Limits & Flow Control | 01 |
| 030 Revenue & P&L Tracking | 04 (→12) | 062 Inbound Intake Channels | 12 |
| 031 Agent-Run Distributed Tracing | 03 | 063 Cost & Capacity Forecasting | 04 |
| 032 A/B Model Bake-Off | 06 | 064 Data Import / Migration | 10 |

## Suggested build order (by importance × foundational-ness)

1. **Combo 01** (Runtime Control Plane) — the safety/cost foundation almost everything composes onto.
2. **Combo 05** (Review Cockpit) — unblocks the human bottleneck that stalls 24/7 autonomy.
3. **Combo 03** (Health Sentinel) — catches the expensive failures that look healthy.
4. **Combo 10** (Day-One Adoption) — without it the rest is academic; drives real usage.
5. **Combo 04** (CFO Suite) + **Combo 02** (Model Economy) — make the business measurable and cheap.
6. **Combo 08** (Zero-Trust Governance) — unlocks operating real, regulated businesses.
7. Then 06, 07, 09, 11, 12, 13 as the company matures toward self-organization and multi-company scale.

## Recurring foundations (shared substrates worth building deliberately)

A few primitives are depended on by many combinations — build them well, once:

- **A `planOnly`/shadow side-effect-free execution mode** — combos 04, 06, 07, 10.
- **A free local model** (combo 02 / idea 008) — powers cheap evals, embeddings, summaries, judging
  across combos 03, 05, 06, 11.
- **The lease/claim pattern** (`environmentLeases`) — secrets (08), workspace locks (01).
- **The company-portability serializer** — blueprints/demo/import (10), snapshots/rewind (09).
- **The tamper-evident audit log** (combo 08) — the trustworthy record every governed action lands in.
- **One governed cross-company seam** (combo 13) — built once, used for oversight, services, and mail.
