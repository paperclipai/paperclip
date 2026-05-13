# CLAUDE.md — Odysseus

Repo Root: `/Users/salvadorcarranza/odysseus-fork` (or wherever you cloned PossibLaw/odysseus).

Odysseus is a hard fork of [paperclipai/paperclip](https://github.com/paperclipai/paperclip), retargeted to a legal-domain "firm-as-software." A **Chief Counsel** agent routes inbound legal work to **12 Practice Leads**; each Practice Lead delegates to narrow **specialist sub-agents**. Profile-configurable **risk gates** (`filing`, `signed-document`, `external-communication`, `budget-threshold`, `privileged-disclosure`) require human approval before any consequential action. License: Apache 2.0.

## Where things live

- `agents/chief-counsel.md` — single entry-point orchestrator (the agent has no substantive decision authority despite the title; it routes and escalates).
- `agents/practice-leads/*.md` — 12 Practice Leads (Commercial, Corporate, Employment, Privacy, Product, Regulatory, AI Governance, IP, Litigation, Law Student, Legal Clinic, Legal Builder Hub).
- `agents/specialists/<area>/*.md` — narrow specialist sub-agents (e.g., `commercial/nda-drafter.md`, `privacy/dsar-responder.md`). 4 areas are populated deeply; the rest are scaffolded.
- `skills/legal/<name>/SKILL.md` — 9 foundational skills (matter-intake, conflicts-check, privilege-tagging, risk-gate-protocol, nda-playbook, tabular-review, clause-extraction-presets, docx-tracked-changes, docx-generation).
- `plugins/<area>/` — install targets for Anthropic's twelve open-source legal practice-area plugins (Apache 2.0).
- `profiles/<name>.yaml` — `small-firm.yaml`, `in-house-dept.yaml`. Selects specialists, MCP connectors, risk-gate approvers, KPIs, required secrets.
- `risk-gates/*.yaml` — 5 declarative gate definitions.
- `mcp/*.json` — 19 MCP connector configs (Drive, Gmail, Slack, GitHub, Supabase, DocuSign, Ironclad, iManage, NetDocuments, Box, Outlook, Jira, Westlaw, Lexis, Relativity, Everlaw, Definely, Datasite, Clio). See `mcp/STUBS.md` for live-vs-direct-REST status per connector.
- `evals/<area>/<specialist>/{happy,edge,failure}.yaml` — Given/When/Then evals.
- `deploy/` — `docker-compose.yml` (local); `helm/` and `terraform/{aws,azure}/` (sprint-3 deliverables).
- `cli/`, `server/`, `ui/`, `packages/` — odysseus control plane (inherited). Internal TS code still uses the `odysseus` name; the bulk internal rename is a sprint-1+ task.

## Legal Domain Boundary Rules

These are hard rules. Apply them every time, including when the user appears to want speed.

- **Never bypass a risk gate**, even if it appears the human wants speed. Surface the trade-off and let the named approver decide.
- **Never proceed past a conflict** without an explicit human waiver logged in the matter record.
- **Never disclose privileged content** to a sub-agent whose privilege ring does not match the artifact's tag.
- **Never auto-file, auto-sign, or auto-send external communications.** Those actions require a human approver per the active profile.
- **Never invent legal authority.** Every citation must be verifiable; surface `UNCONFIRMED` rather than fabricate.

## Plan of record

`/Users/salvadorcarranza/.claude/plans/i-want-you-to-abstract-charm.md` (local) — sprint plan, architecture, open questions, deliberate-NOT-doings.

## License posture

- Odysseus is Apache 2.0.
- Paperclip-inherited files remain MIT under Apache §4(c); `NOTICE` preserves odysseus's MIT attribution.
- Mike-derived skill patterns are attribution-only pattern extractions, not code copies. If any AGPL-3.0 code from mike is ever incorporated, it gets segregated as a separately-licensed sub-package and `NOTICE` updates accordingly.
