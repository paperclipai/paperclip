---
name: Product Engineering
description: Bundled engineering team that pairs a CTO with a senior coder and a QA engineer to deliver, review, and verify product changes.
schema: agentcompanies/v1
slug: product-engineering
category: software-development
key: paperclipai/bundled/software-development/product-engineering
manager: agents/cto/AGENTS.md
includes:
  - agents/senior-coder/AGENTS.md
  - agents/qa/AGENTS.md
  - projects/product-engineering/PROJECT.md
defaultInstall: false
recommendedForCompanyTypes:
  - software
  - startup
  - product
tags:
  - engineering
  - delivery
  - qa
  - code-review
requiredSkills:
  - paperclipai/bundled/software-development/github-pr-workflow
  - paperclipai/bundled/quality/qa-acceptance
  - paperclipai/bundled/paperclip-operations/task-planning
  - paperclipai/bundled/docs/doc-maintenance
---

# Product Engineering

An optional drop-in engineering pod for companies that want a working software-delivery loop without going through the catalog's `core-exec-team` first. Install it under an existing CEO/manager and the imported CTO will own engineering execution.

## Contents

- `CTO` — engineering manager and team root. Reviews PRs, owns code-quality standards, and breaks product priorities into engineering tasks.
- `senior-coder` — primary implementer. Picks up engineering tasks, ships PRs, and asks QA for verification.
- `QA` — verifies fixes and captures acceptance evidence.
- `product-engineering` project — the rolling backlog this pod works against.
- `weekly-engineering-sync` routine — recurring CTO-owned check-in to surface blockers and confirm the next deliverable.

## Skill rationale

- `github-pr-workflow` keeps logical commits, branch hygiene, and merge discipline consistent across the pod.
- `qa-acceptance` gives QA a structured pass/fail format coders can act on.
- `task-planning` lets the CTO turn larger asks into well-scoped child issues.
- `doc-maintenance` keeps docs aligned with shipped changes — install if the company has any user-facing docs surface.

## Migration notes

This entry is derived from the `Coder` and `QA` role templates in `skills/paperclip-create-agent/references/agents/` plus the historical CTO persona under `server/src/onboarding-assets/`. Adapter-type defaults (claude_local vs codex_local) are intentionally left out of frontmatter so the import preview can let operators choose per-agent. SecurityEngineer is intentionally deferred to the future `optional/quality/security-review` entry, since most installs will not want a dedicated security agent on day one.
