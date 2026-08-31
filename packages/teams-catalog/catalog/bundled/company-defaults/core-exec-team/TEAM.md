---
name: Core Exec Team
description: Default leadership and engineering team for bootstrapping a Paperclip company with a CEO, CTO, QA Engineer, starter project, and a recurring CEO heartbeat review task.
schema: agentcompanies/v1
slug: core-exec-team
category: company-defaults
key: paperclipai/bundled/company-defaults/core-exec-team
manager: agents/ceo/AGENTS.md
includes:
  - agents/cto/AGENTS.md
  - agents/qa/AGENTS.md
  - projects/first-project/PROJECT.md
defaultInstall: true
recommendedForCompanyTypes:
  - startup
  - software
  - generalist
tags:
  - default
  - executive
  - engineering
  - qa
requiredSkills:
  - paperclipai/bundled/paperclip-operations/task-planning
  - paperclipai/bundled/paperclip-operations/issue-triage
  - paperclipai/bundled/software-development/github-pr-workflow
  - paperclipai/bundled/quality/qa-acceptance
---

# Core Exec Team

The Core Exec Team is the bundled default install for a new Paperclip company. It boots the smallest org that can take a board prompt, plan it, implement it, and verify it.

## Contents

- `CEO` — strategy, prioritization, delegation. Uses `task-planning` and `issue-triage` to keep the inbox moving.
- `CTO` — technical execution and engineering oversight. Reports to CEO. Uses `github-pr-workflow` for code review and merge hygiene.
- `QA` — verifies fixes and captures evidence. Reports to CTO. Uses `qa-acceptance` for structured acceptance reports.
- `first-project` — starter project under the CTO for converting the company goal into the first implementation task.
- `first-heartbeat` — recurring CEO heartbeat to review priorities and confirm the next useful task.

## Migration notes

This entry mirrors the historical `server/src/onboarding-assets/ceo/` template family while staying inside the catalog package boundary. Per-agent persona files (the legacy `SOUL.md`, `HEARTBEAT.md`, `TOOLS.md` siblings) are intentionally collapsed into a single `AGENTS.md` per agent so importer/portability semantics stay simple. The richer persona content can move into `references/` files in a follow-up once onboarding actually switches to the catalog service.
