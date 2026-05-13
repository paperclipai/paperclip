<p align="center">
  <strong>Odysseus</strong>
</p>

<p align="center">
  An agentic legal organization, in a box.
</p>

<p align="center">
  <a href="#quickstart"><strong>Quickstart</strong></a> &middot;
  <a href="#architecture"><strong>Architecture</strong></a> &middot;
  <a href="#profiles"><strong>Profiles</strong></a> &middot;
  <a href="#risk-gates-v1"><strong>Risk gates</strong></a> &middot;
  <a href="https://github.com/PossibLaw/odysseus"><strong>GitHub</strong></a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache_2.0-blue" alt="Apache 2.0" /></a>
  <a href="https://github.com/PossibLaw/odysseus/stargazers"><img src="https://img.shields.io/github/stars/PossibLaw/odysseus?style=flat" alt="Stars" /></a>
</p>

---

## What is Odysseus?

50 specialist AI lawyers, one Chief Counsel, human approval at every risk gate. Open-source legal-firm-as-software for small firms and in-house legal teams.

A solo lawyer or in-house GC handles dozens of distinct disciplines in a day: intake, conflicts, drafting, redlining, research, discovery, filings, billing, client communications. Each is its own skill. Generalist AI agents that try to do all of them produce mediocre, ungated output. Odysseus inverts the pattern: a deep bench of narrow specialists, one orchestrator (Chief Counsel) that knows the bench, and human approval at every point that matters.

This pattern matches what Anthropic shipped for legal on May 12, 2026 — twelve practice-area plugins, 20+ MCP connectors, Claude for Word/Outlook/Cowork, and Skills for "playbooks and standards." Odysseus assembles those pieces into an opinionated, deployable product on top of [paperclip's](https://github.com/paperclipai/paperclip) agent control plane.

## Profiles

Same codebase, two product shapes selected at install:

- `small-firm` — 5–25 lawyer transactional/litigation firm. Partner-controlled risk gates. Practice areas tilted to Commercial, Corporate, Employment, IP, Litigation, Privacy.
- `in-house-dept` — GC + 3–10 lawyer in-house department at a mid-size company. GC-controlled risk gates. Practice areas tilted to Commercial, Privacy, Employment, IP, Regulatory, AI Governance.

See `profiles/small-firm.yaml` and `profiles/in-house-dept.yaml` for the canonical examples.

## Architecture

```
Chief Counsel (single entry point)
   │
   ├─ Pre-flight skills: matter-intake → conflicts-check → privilege-tagging
   │
   ├─ 12 Practice Leads (Commercial, Corporate, Employment, Privacy, Product,
   │     Regulatory, AI Governance, IP, Litigation, Law Student, Legal Clinic,
   │     Legal Builder Hub) — mirrors Anthropic's plugin set
   │
   ├─ ~30–50 specialist sub-agents (NDA-drafter, MSA-redliner, DSAR-responder,
   │     trademark-clearance, CP-checklist-generator, ...)
   │
   └─ Risk gates → human approval (filing, signed-document,
                                   external-communication, budget-threshold,
                                   privileged-disclosure)
```

Inherited from paperclip: identity & access, org chart, work/task system, heartbeat execution, budgets, governance/approvals, workspaces (worktrees), plugins, company portability.

## Repository layout

```
odysseus/
├── agents/                 — Odysseus's legal sub-agents
│   ├── chief-counsel.md       Single entry-point orchestrator
│   ├── practice-leads/        12 Practice Lead agents
│   └── specialists/           Narrow, one-job-each sub-agents
├── skills/legal/           — Foundational legal skills
│   ├── matter-intake/         Profile-driven intake validation
│   ├── conflicts-check/       Conflicts of interest check (mandatory)
│   ├── privilege-tagging/     Privilege ring assignment / propagation
│   ├── risk-gate-protocol/    Gate evaluation + approval-card builder
│   ├── nda-playbook/          House NDA positions library
│   ├── tabular-review/        Multi-doc citation-backed table extraction
│   ├── clause-extraction-presets/  13 standard clause extractors
│   ├── docx-tracked-changes/  Word redline machinery (contract spec)
│   └── docx-generation/       Structured DOCX output (contract spec)
├── plugins/                — Anthropic's 12 legal plugins install here
├── profiles/               — small-firm.yaml, in-house-dept.yaml
├── risk-gates/             — 5 declarative gate YAMLs
├── mcp/                    — 19 MCP connector configs
├── evals/                  — Specialist eval suite (Given/When/Then)
├── deploy/                 — docker-compose (local); helm + terraform (cloud)
├── cli/  server/  ui/  packages/        — paperclip control plane (inherited from upstream)
└── FORK.md                 — Fork link / upstream sync workflow
```

## Quickstart

> v0.1 — sprint 1 internal rename in progress. The TypeScript control plane
> is being renamed from upstream `paperclip` to `odysseus` across this branch.

```bash
# Local laptop
git clone https://github.com/PossibLaw/odysseus
cd odysseus
git checkout master   # odysseus's default branch (inherited from paperclip)
pnpm install
# Run the inherited control plane while we incrementally swap in the legal layer:
pnpm dev
```

Cloud deploys: see `deploy/` (docker-compose for local; Helm and Terraform AWS / Azure modules are sprint-3 deliverables).

## Risk gates (v1)

Every Odysseus deployment ships with five declarative risk-gate definitions; each profile decides who approves and when.

| Gate | Triggers | Approver (small-firm) | Approver (in-house-dept) |
|---|---|---|---|
| `filing` | Court / agency submission | partner | gc |
| `signed-document` | Send to e-sign / execute | partner-of-record | deputy-gc |
| `external-communication` | Email/letter to external party | matter-partner | gc-or-deputy |
| `budget-threshold` | Spend over $ threshold | billing-partner | gc |
| `privileged-disclosure` | Share privileged artifact outside ring | matter-partner | gc |

Gates are declarative (`risk-gates/*.yaml`) and cannot be bypassed by agents.

## Practice areas

All twelve are scaffolded (mirroring Anthropic's open-source plugin set). Five areas are populated in v1 with specialist sub-agents (Commercial, Corporate, Employment, Privacy, IP). The remaining seven (Litigation, Product, Regulatory, AI Governance, Law Student, Legal Clinic, Legal Builder Hub) ship with Practice Lead stubs.

## What v1 deliberately does NOT do

- **Multi-tenant SaaS** — privilege isolation risk is too high to architect on day one.
- **UPL-compliant consumer-direct chat** — Odysseus is operated by a lawyer or in-house department; it does not give legal advice to laypeople.
- **Bar-grade citation verification** — citations surface, but a human approver signs off at the risk gate.
- **Patent prosecution** — out of scope (USPTO bar admission required).

## License

[Apache 2.0](LICENSE). Inherited from [paperclip](https://github.com/paperclipai/paperclip) (MIT) and upgraded — Apache 2.0 matches Anthropic's twelve practice-area plugins and provides an explicit patent grant appropriate for a legal product. The [NOTICE](NOTICE) file preserves paperclip's MIT origin attribution.

Some skill patterns are extracted with attribution from [willchen96/mike](https://github.com/willchen96/mike) (AGPL-3.0). No mike code has been incorporated; only workflow patterns. See [NOTICE](NOTICE) for full attribution.

## Status

**v0.1 — scaffolding sprint.** Foundational artifacts shipped:
- Chief Counsel agent + 12 Practice Leads + 13 specialist sub-agents
- 9 foundational legal skills
- 2 profiles, 5 risk gates, 19 MCP connector configs
- 3 evals (Given/When/Then)
- License swap (MIT → Apache 2.0)

**Sprint 1 (in progress):** internal `paperclip` → `odysseus` rename in TS code; legal-domain server models (Matter, Client, ConflictRecord, PrivilegeFlag, Approval, RiskGate); Chief Counsel routing + risk-gate engine wiring. **Then:** populate the remaining specialist roster; first end-to-end matter eval running against the renamed control plane.
