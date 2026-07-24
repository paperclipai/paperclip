---
name: Product Design
description: Bundled product design team with a Principal Product Designer who owns wireframes, design critiques, and UX quality reviews for a product company.
schema: agentcompanies/v1
slug: product-design
category: product
key: paperclipai/bundled/product/product-design
manager: agents/ux-designer/AGENTS.md
includes:
  - projects/product-design/PROJECT.md
defaultInstall: false
recommendedForCompanyTypes:
  - software
  - product
  - design
tags:
  - design
  - ux
  - product
requiredSkills:
  - paperclipai/bundled/product/wireframe
  - paperclipai/optional/product/design-critique
  - paperclipai/bundled/paperclip-operations/task-planning
---

# Product Design

A minimal design team built around a single Principal Product Designer. Install alongside an existing engineering team to add wireframing, design critique, and UX-quality review capacity.

## Contents

- `UXDesigner` — Principal Product Designer and team root. Produces wireframes, runs design critiques, and reviews UX-visible PRs.
- `product-design` project — rolling backlog for design specs, reviews, and system updates.
- `weekly-design-review` routine — recurring designer-owned check-in to triage open design work and catch UX regressions early.

## Skill rationale

- `wireframe` (bundled) — structured low-fidelity wireframing for new flows.
- `design-critique` (optional skill catalog) — structured visual/UX critique format. Installs from the skill catalog as a prerequisite at team install time.
- `task-planning` — breaks larger design asks into reviewable child issues.

## Migration notes

Derived from the `UXDesigner` template in `skills/paperclip-create-agent/references/agents/uxdesigner.md`. The full visual-quality and design-lens documentation lives in the template's `AGENTS.md` body rather than as `references/` files so the catalog manifest stays at trust level `markdown_only`. Adapter type is intentionally omitted from frontmatter; the import preview lets operators pick `claude_local`, `codex_local`, or another adapter at install time.
