# CLAUDE.md

Guidance for Claude and other AI contributors working in this repository.

## Operator Memory

Before starting technical work, check Darwin Brain tenant `codex-cli` for relevant environment, repo, and recovery memory when that tool is available.

Use it for durable operator context such as:
- local Paperclip/OpenClaw runtime quirks
- known recovery procedures
- Darwin bridge integration facts
- repo-specific engineering gotchas

Do not treat `codex-cli` as a source of truth over the codebase. It is a fast context layer to reduce repeated mistakes and re-discovery.

## Core Docs

Read these first:
1. `doc/GOAL.md`
2. `doc/PRODUCT.md`
3. `doc/SPEC-implementation.md`
4. `doc/DEVELOPING.md`
5. `doc/DATABASE.md`
