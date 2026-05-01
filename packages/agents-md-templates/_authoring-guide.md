# AGENTS.md Template Kit — Authoring Guide

This directory contains canonical `AGENTS.md` templates for the five core Platform agent roles. Templates serve two purposes:

1. **New-hire starting point** — the `paperclip-create-agent` skill references these so new agents start from a lint-clean baseline.
2. **Drift guard** — live `AGENTS.md` files are checked against the template's verbatim regions via `agents-md-lint`. If a verbatim region drifts from the template, lint rule **AM402** fires an error.

---

## Quick start

```bash
# Copy the template for your role
cp packages/agents-md-templates/Coder.md AGENTS.md

# Fill in placeholders
sed -i 's/{{agentName}}/MyEngineer/g; s/{{companyName}}/Acme/g; s/{{managerTitle}}/CTO/g; s/{{issuePrefix}}/ACM/g' AGENTS.md

# Lint your draft (zero errors required before hire)
agents-md-lint --against-template packages/agents-md-templates/Coder.md AGENTS.md
```

---

## Template index

| File | Role | Hire via `paperclip-create-agent` |
|---|---|---|
| `Coder.md` | IC software engineer | `references/agents/coder.md` |
| `QA.md` | IC QA / verification engineer | `references/agents/qa.md` |
| `CTO.md` | Manager, engineering org | — (manager hire, escalate to CEO) |
| `UXDesigner.md` | IC product designer | `references/agents/uxdesigner.md` |
| `SecurityEngineer.md` | IC security engineer | `references/agents/securityengineer.md` |

---

## Required vs optional sections

The following sections are **required** in every `AGENTS.md` (lint rule AM001 enforces presence):

| Section | Why required |
|---|---|
| Role / identity line (`You are agent …`) | Sets the agent's identity and company context |
| Heartbeat skill invocation (`follow the Paperclip skill`) | Ensures heartbeat procedure is loaded |
| Reporting line (`You report to …`) | Sets scope and escalation chain |
| Working rules | Core operating contract |
| Execution contract (verbatim) | Enforced by AM402 |
| Safety and permissions | Required by governance policy |
| Heartbeat-exit instruction (verbatim) | Enforced by AM402 |
| Done criteria | Defines when work is complete |

The following sections are **optional** but strongly recommended for lens-heavy roles (SecurityEngineer, UXDesigner):

- Domain lenses (cite by name in comments)
- Role-specific output bar
- Collaboration and handoffs detail
- Visual-truth gate (UXDesigner)
- Review bar / remediation bar (SecurityEngineer)

---

## The drift guard: `lint:verbatim` markers

Templates mark certain sections with:

```html
<!-- lint:verbatim:start -->
…exact text that must not drift…
<!-- lint:verbatim:end -->
```

The `agents-md-lint` tool (rule **AM402**) extracts each verbatim region from the template and verifies it appears byte-for-byte in the live `AGENTS.md` being checked.

### What is currently marked verbatim (all templates)

1. **Execution contract** — the single paragraph beginning with `Start actionable work in the same heartbeat`. This paragraph must not be paraphrased, shortened, or split across bullets.

2. **Safety preamble** — the bullet list under `## Safety and permissions`. This list is role-specific; Coder, QA, and CTO templates contain the live Platform text. UXDesigner and SecurityEngineer templates use placeholder-friendly text and are verified on a best-effort basis until those agents are hired.

3. **Heartbeat-exit instruction** — the final instruction. For most roles this is:
   > `You must always update your task with a comment before exiting a heartbeat.`
   For QA it is shorter:
   > `You must always update your task with a comment.`

### How to extend a template without breaking the drift guard

**Do:**
- Add new `## Sections` before or after existing ones.
- Expand the non-verbatim parts of existing sections.
- Add role-specific lenses, workflows, or collaboration notes outside the marked regions.
- Add a second `<!-- lint:verbatim:start -->` block for a new canonical phrase you want enforced.

**Don't:**
- Edit text that falls inside a `<!-- lint:verbatim:start -->` … `<!-- lint:verbatim:end -->` block. If you believe the canonical phrase should change, update the template file and all live AGENTS.md files in the same commit, then confirm with CTO before merging.
- Remove or reorder verbatim markers. The lint tool matches regions by order, not by label.
- Add company-specific references (agent names, issue prefixes) inside verbatim regions. Verbatim regions must contain only universal text so templates can be reused across companies.

---

## How to run the lint

### Against a template (pre-hire check)

```bash
# Zero errors required before submitting a hire request
agents-md-lint --against-template packages/agents-md-templates/Coder.md path/to/AGENTS.md
```

### Against all templates at once (CI)

```bash
# Run from the repo root; checks each live file against its matching template
agents-md-lint --kit packages/agents-md-templates/
```

### Interpreting output

| Code | Severity | Meaning |
|---|---|---|
| AM001 | error | Required section missing |
| AM402 | error | Verbatim region has drifted from template |
| AM201 | warning | Placeholder token (`{{…}}`) found in installed file |
| AM301 | warning | Recommended section absent |

Fix all `error` diagnostics before the hire request. `warning` diagnostics are advisory.

---

## Placeholders

Templates use `{{doubleBrace}}` placeholders for values that vary by company and agent:

| Placeholder | Replace with |
|---|---|
| `{{agentName}}` | Agent display name (e.g. `ClaudeCoder`) |
| `{{companyName}}` | Company short name (e.g. `Platform`) |
| `{{managerTitle}}` | Manager role title (e.g. `CTO`) |
| `{{issuePrefix}}` | Issue prefix for this company (e.g. `PLA`) |

Replace all placeholders before submitting a hire request. AM201 will warn if any remain in an installed file.

---

## Lint consistency with sibling issue PLA-15

The regex patterns used by `agents-md-lint` to identify verbatim block boundaries are:

```
^<!-- lint:verbatim:start -->$
^<!-- lint:verbatim:end -->$
```

These must match exactly (no extra whitespace, no trailing characters). The template files in this directory use these exact strings. If the lint implementation in [PLA-15](/PLA/issues/PLA-15) ever changes the marker syntax, update all templates in lock-step in the same PR.

---

## Adding a new template

1. Copy the closest existing template.
2. Rewrite the role identity, charter, and working rules for the new role.
3. Keep all three verbatim blocks intact (execution contract, safety preamble, heartbeat-exit). Update only the safety preamble bullets to match the new role's actual safety rules.
4. Replace `{{placeholders}}` with documentation-friendly defaults (not real values).
5. Add the new template to the index table in this file.
6. Run `agents-md-lint --against-template packages/agents-md-templates/<NewRole>.md <path-to-a-sample-AGENTS.md>` to confirm zero errors.
7. Update `skills/paperclip-create-agent/references/agent-instruction-templates.md` to include the new entry if the role is generally hirable.
8. Get CTO sign-off before merging.
