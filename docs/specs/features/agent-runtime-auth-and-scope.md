---
id: paperclip-agent-runtime-auth-scope
title: Agent Runtime Auth and Company Scope
doc_type: spec
owner: paperclip
status: active
version: 1.0.0
updated: 2026-03-05
applies_to:
  - server/src/middleware
  - server/src/api
  - adapters
depends_on:
  - /home/avi/projects/paperclip/doc/spec/agent-runs.md
  - /home/avi/projects/paperclip/docs/api/authentication.md
related_docs:
  - /home/avi/projects/paperclip/AGENTS.md
toc: auto
---

# Agent Runtime Auth and Company Scope

## Contract

- Agent credentials must map to a single company scope.
- Board/human auth and agent auth remain distinct paths.
- Runtime adapters must not bypass company boundary checks.

## Required Checks

- forbidden cross-company access tests
- auth failure semantics (`401/403`) documented and tested
- activity/audit visibility for mutating operations
