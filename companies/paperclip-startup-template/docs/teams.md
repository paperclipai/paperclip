# Teams — Paperclip Startup Template

This document defines the **default 8-role lineup** every company instantiated from this template starts with, the reporting lines, and the `desiredSkills` bundles each role ships with on day one.

The org chart is opinionated. Companies that need a different shape can drop roles before importing or hire additional roles after. The defaults are the smallest set that lets a company take work end-to-end (intake → plan → implement → verify → ship) without leaving a lane uncovered.

---

## 1. Org chart

```
                                CEO
                                 │
                ┌────────────────┼────────────────┐
                │                │                │
              CMO              CTO            (UXDesigner — optional, hire-when-needed)
                                 │
       ┌─────────────────┬───────┴────────┬──────────────────┬───────────────────────┐
       │                 │                │                  │                       │
FrontendEngineer  BackendEngineer       Coder              QA              SecurityEngineer
```

**Reporting lines:**

- CEO is the root. Every CEO-rooted task lands on the CTO (for technical work) or the CMO (for marketing). CEO does not assign work directly to engineers.
- CTO is the single point of contact between CEO and the engineering org. CTO delegates to FrontendEngineer / BackendEngineer / Coder / QA / SecurityEngineer.
- CMO reports to CEO. CMO does not have direct reports in the default template; CMO proposes hires (content, growth, designer) to CEO when scale demands.
- UXDesigner is **not** in the default lineup. Hire when the company has user-facing product surfaces that need dedicated design work. Until then, UX-facing concerns escalate to CTO.

---

## 2. Role definitions and capabilities

Each role's `AGENTS.md` carries the full long-form definition. This table is the at-a-glance summary.

| Role | One-line definition | Capabilities (adapter typical) | Reports to |
|------|---------------------|--------------------------------|------------|
| **CEO** | Owns strategy, prioritization, hiring, board comms | `claude_local` or `codex_local`; carries `canCreateAgents=true` only when authorized | Board / operator |
| **CTO** | Owns technical roadmap, delegation, specs; never cuts code | `claude_local`; `canCreateAgents=true` for engineering hires | CEO |
| **CMO** | Owns brand, positioning, marketing roadmap | `claude_local`; no agent-create rights by default | CEO |
| **FrontendEngineer** | Owns client code, UI, accessibility, FE build | `claude_local` or `codex_local`; coding adapter | CTO |
| **BackendEngineer** | Owns server, API, data, infra-as-code | `claude_local` or `codex_local`; coding adapter | CTO |
| **Coder** | Generalist software engineer; the issue → plan → implement → commit → PR loop | `codex_local`, `claude_local`, `cursor`, or other coding adapter | CTO |
| **QA** | Owns test design, browser verification, test harness | Coding adapter + Playwright MCP for browser flows | CTO |
| **SecurityEngineer** | Owns security reviews, threat modeling, security skills | `claude_local`; minimal external reach by default | CTO |

**Adapter choice is a per-deployment decision.** The template does not pin a specific adapter; the operator selects one at import time. Coding-heavy roles (FE/BE/Coder/QA-test-code) want a coding-capable adapter; advisory roles (CEO/CTO/CMO/Security) are fine on a general adapter.

---

## 3. Capability flags (defaults)

| Flag | CEO | CTO | CMO | FE | BE | Coder | QA | Security |
|------|-----|-----|-----|----|----|-------|----|----------|
| `canCreateAgents` | optional (operator decides) | yes (engineering hires) | no | no | no | no | no | no |
| `canInstallCompanySkills` | yes | yes | no | no | no | no | no | yes (with justification) |
| `timerHeartbeat` | off | off | off | off | off | off | off | off |
| Browser/MCP access | no | no | no | no (unless task-scoped) | no (unless task-scoped) | no (unless task-scoped) | yes (Playwright MCP) | no (review-only by default) |
| External network reach | no | no | no | no | scoped (deploy targets only) | no | no | no |

Every flag set above the default-off baseline must be justified on the linked issue and reviewed at hire time. Default off; expand with a comment trail.

---

## 4. `desiredSkills` bundles per role

Each role's hire request includes a `desiredSkills` array — the company skills installed and attached on day one. Slugs resolve to canonical company skill keys at hire time; every skill must already be installed in the company library or the hire is gated until install.

### CEO

```json
"desiredSkills": [
  "paperclip-create-agent",
  "para-memory-files",
  "progress-comment-template"
]
```

- `paperclip-create-agent` — CEO approves hires; the skill carries the draft-review checklist.
- `para-memory-files` — CEO maintains a personal knowledge graph + daily notes for strategic continuity.
- `progress-comment-template` — the five-section comment contract.

### CTO

```json
"desiredSkills": [
  "paperclip-create-agent",
  "paperclip-converting-plans-to-tasks",
  "diagnose-why-work-stopped",
  "progress-comment-template"
]
```

- `paperclip-create-agent` — CTO drafts and submits engineering hires.
- `paperclip-converting-plans-to-tasks` — CTO's job is plan → delegated child issues; this skill is the conversion contract.
- `diagnose-why-work-stopped` — when a delegated tree stalls, CTO uses this skill before reflexively pushing the worker harder.
- `progress-comment-template` — the five-section comment contract.

### CMO

```json
"desiredSkills": [
  "progress-comment-template"
]
```

- `progress-comment-template` — the five-section comment contract.

Additional marketing skills (positioning, messaging house, brand voice authoring) can be added as the marketing function matures. Default ships lean.

### FrontendEngineer

```json
"desiredSkills": [
  "progress-comment-template",
  "paperclip-classify-issue",
  "paperclip-plan-from-issue",
  "paperclip-implement-plan",
  "paperclip-commit-message",
  "paperclip-pr-from-branch",
  "paperclip-branch-name",
  "design-guide"
]
```

The seven-skill lifecycle bundle (issue → plan → implement → commit → PR → branch-name, all anchored by `progress-comment-template`) plus the company's UI `design-guide` for consistent component work.

### BackendEngineer

```json
"desiredSkills": [
  "progress-comment-template",
  "paperclip-classify-issue",
  "paperclip-plan-from-issue",
  "paperclip-implement-plan",
  "paperclip-commit-message",
  "paperclip-pr-from-branch",
  "paperclip-branch-name"
]
```

The seven-skill lifecycle bundle. No design-guide — server work is not styled.

### Coder

```json
"desiredSkills": [
  "progress-comment-template",
  "paperclip-classify-issue",
  "paperclip-plan-from-issue",
  "paperclip-implement-plan",
  "paperclip-commit-message",
  "paperclip-pr-from-branch",
  "paperclip-branch-name"
]
```

Same seven-skill bundle. The Coder template is the canonical home of this bundle; FE/BE inherit it because they run the same issue → plan → implement → commit → PR loop. State any deviation in the hire comment.

### QA

```json
"desiredSkills": [
  "progress-comment-template",
  "paperclip-classify-issue",
  "paperclip-plan-from-issue",
  "paperclip-implement-plan",
  "paperclip-commit-message",
  "paperclip-pr-from-branch",
  "paperclip-branch-name"
]
```

QA authors and commits test code, so it carries the same lifecycle bundle. Browser automation comes from the Playwright MCP attached at adapter level, not from a separate skill.

### SecurityEngineer

```json
"desiredSkills": [
  "progress-comment-template",
  "paperclip-classify-issue",
  "paperclip-plan-from-issue",
  "paperclip-commit-message",
  "security-review"
]
```

- `security-review` — the security-review playbook for the company's branch/PR flow.
- The lifecycle skills minus `paperclip-implement-plan` and `paperclip-pr-from-branch` — SecurityEngineer authors remediation specs and reviews PRs but does not own the implement-and-merge loop except for its own skill authorship.

SecurityEngineer also authors and installs additional security-domain skills over time (e.g. `gdpr-pii-handling`, `auth-review-checklist`, `dependency-supply-chain`). Each install is justified on a linked issue.

---

## 5. Hiring discipline

- **CEO approves every hire.** CTO and (when scaled) CMO submit; CEO accepts via `request_confirmation`.
- **Use the `paperclip-create-agent` skill end-to-end.** The skill carries the draft-review checklist: source issue id, role definition, charter, lenses, capability flags, `desiredSkills`, icon, and the instruction-source path. A hire that names "be helpful, be thorough" instead of role-specific lenses is not done.
- **Dedup before celebrating.** After a hire issue is closed, verify role count. A duplicate role created in a parallel run is wasted budget and confused ownership.
- **Hire slow, fire fast, avoid leadership vacuums.** Leadership roles (CTO, CMO, future VPs) get the most scrutiny on the way in.

---

## 6. When to add to the default lineup

Add roles when one of these conditions is true; until then, the 8-role default carries the load:

- **UXDesigner** — when the product has user-facing surfaces that need dedicated visual/UX design, not just engineering implementation. Until present, UX-facing decisions escalate to CTO.
- **Additional Coders** — when the engineering queue consistently exceeds throughput and the work is parallelizable. State the throughput problem and the parallelism case in the hire issue.
- **Domain specialists** (DataEngineer, MLEngineer, DevOps, SRE, etc.) — when the work has a sustained specialty surface beyond what FE/BE/Coder can absorb without breaking lane boundaries.
- **Marketing reports under CMO** (Content, Growth, BrandDesigner) — when the marketing roadmap has enough scope that CMO becomes the bottleneck.

Each added role gets its own `AGENTS.md`, lane boundary, capability flags, and `desiredSkills` bundle, recorded in this document on the next revision.

---

## 7. When to remove from the default lineup

Some companies will not need every default role on day one. The template is a starting point, not a contract.

- **Remove CMO** if the company is purely internal or pre-marketing. Keep CEO/CTO/FE/BE/QA/Security at minimum.
- **Remove SecurityEngineer** only if the company is short-lived, demo-only, and has no production/PII surface. Most companies should keep it; security debt compounds.
- **Combine FrontendEngineer + BackendEngineer into a single Coder** if the codebase is small enough that lane separation costs more than it gives. Document the consolidation in the company's `COMPANY.md` so the lane-discipline rule reads correctly.

Removals are a one-way door at company-creation time only. Adding a role later is cheap; removing one mid-flight orphans assigned issues.
