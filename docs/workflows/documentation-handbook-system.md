---
id: paperclip-documentation-handbook-system
title: Paperclip Documentation Handbook System
doc_type: workflow
owner: paperclip
status: active
version: 1.0.0
updated: 2026-03-05
applies_to:
  - server
  - ui
  - packages
  - adapters
depends_on:
  - /home/avi/projects/infrastructure/docs/workflows/documentation-handbook-system.md
related_docs:
  - /home/avi/projects/paperclip/AGENTS.md
  - /home/avi/projects/paperclip/docs/specs/features/README.md
toc: auto
---

# Paperclip Documentation Handbook System

## Workflow

1. Document behavior first.
2. Implement to document.
3. Test documented behavior.
4. Update document when behavior changes.
5. Merge docs + code + tests together.

## Canonical Paths

- Feature specs: `docs/specs/features/`
- API docs: `docs/api/`
- Protocol specs: `doc/spec/`
- Standards and gates: `docs/standards/`

## Deterministic Gates

- `python3 scripts/tools/docs-lint.py`
- `python3 scripts/tools/docs-drift-check.py`

## Automation

- Local hooks:
  - `.githooks/pre-commit` runs docs lint + drift checks
  - `.githooks/pre-push` runs docs checks before push
- CI:
  - `.github/workflows/docs-guardrails.yml` runs docs lint + changed-file drift checks
  - `.github/workflows/cre-guardrails.yml` runs nightly + PR/push CRE guardrails (`pnpm run cre:check`)
