---
name: Full SDLC Team
description: End-to-end software delivery team covering analysis, design, build, test, security and DevOps, with human approval gates between phases.
schema: agentcompanies/v1
slug: full-sdlc-team
category: software-development
key: paperclipai/optional/software-development/full-sdlc-team
manager: agents/delivery-lead/AGENTS.md
includes:
  - agents/business-analyst/AGENTS.md
  - agents/architect/AGENTS.md
  - agents/ux-designer/AGENTS.md
  - agents/backend-dev/AGENTS.md
  - agents/frontend-dev/AGENTS.md
  - agents/mobile-dev/AGENTS.md
  - agents/qa/AGENTS.md
  - agents/security/AGENTS.md
  - agents/devops/AGENTS.md
  - projects/delivery/PROJECT.md
defaultInstall: false
recommendedForCompanyTypes:
  - software
  - agency
  - startup
tags:
  - engineering
  - sdlc
  - devops
  - qa
  - security
requiredSkills:
  - paperclipai/bundled/software-development/github-pr-workflow
  - paperclipai/bundled/quality/qa-acceptance
  - paperclipai/bundled/paperclip-operations/task-planning
  - paperclipai/bundled/docs/doc-maintenance
  - paperclipai/bundled/product/wireframe
---

# Full SDLC Team

A ten-role delivery team that takes a project from raw requirements to a verified, deployable build.

## Phases and gates

The Delivery Lead runs one phase at a time. Each phase ends with a gate: the Lead posts a summary and waits for board approval before opening the next phase.

1. **Analysis** — Business Analyst: requirements, user stories, acceptance criteria. Gate: scope approved.
2. **Design** — Architect (system, DB, API contracts) and UX Designer (screens, Arabic/RTL). Gate: design approved.
3. **Build** — Backend, Frontend, Mobile developers work in parallel against the API contract. Gate: feature-complete.
4. **Verify** — QA (acceptance and E2E), Security (review). Fix order: Critical, High, Medium, Low. Gate: no open Critical/High.
5. **Ship** — DevOps: Docker, CI, deploy, monitoring. Production changes go through a branch, never directly to main. Gate: release approved.

## Default stack

Laravel API, Next.js/React web, Flutter mobile, Docker Compose locally first, bilingual Arabic/English with full RTL. Roles follow the project's own stack when it differs.

## Contents

- `delivery-lead` — manager; plans phases, assigns work, enforces gates.
- `business-analyst`, `architect`, `ux-designer` — analysis and design.
- `backend-dev`, `frontend-dev`, `mobile-dev` — implementation.
- `qa`, `security`, `devops` — verification and release.
- `delivery` project and `weekly-delivery-review` routine.
