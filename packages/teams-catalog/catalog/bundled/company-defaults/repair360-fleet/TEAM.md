---
name: Repair360 Fleet
description: Six-department operating team for a multi-tenant Repair360 SaaS, with OpenClaw as the execution runtime and Core360 as the system of record.
schema: agentcompanies/v1
slug: repair360-fleet
category: company-defaults
key: paperclipai/bundled/company-defaults/repair360-fleet
manager: agents/director/AGENTS.md
includes:
  - agents/director/AGENTS.md
  - agents/sonia/AGENTS.md
  - agents/chiara/AGENTS.md
  - agents/giorgia/AGENTS.md
  - agents/openclaw-engineering/AGENTS.md
  - agents/qa-audit/AGENTS.md
  - projects/repair360-fleet/PROJECT.md
  - tasks/tenant-boundary-check/TASK.md
defaultInstall: false
recommendedForCompanyTypes:
  - company-root
  - software
  - product
tags:
  - repair360
  - multi-tenant
  - fleet
  - openclaw
  - operations
---

# Repair360 Fleet

An on-demand operating team for Repair360. The Director coordinates priorities; each department owns one boundary; OpenClaw executes assigned work; Core360 remains the only business-data source of truth.

## Operating model

- Work enters through the Director or a named department owner.
- Every handoff carries a task, acceptance criteria, tenant scope, and next action.
- OpenClaw is the only execution runtime in this package; Paperclip provides hierarchy, tasks, budgets, and audit.
- The QA & Audit department closes work with tests, a receipt, and rollback notes.
- No recurring LLM heartbeat is installed by default; agents wake on assignment or an explicit event.
