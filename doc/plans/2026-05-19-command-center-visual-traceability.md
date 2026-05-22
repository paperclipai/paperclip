# Paperclip Command Center — Visual Traceability MVP

Date: 2026-05-19

## Concept

The Command Center is Paperclip's visual cockpit for AI squad traceability. It connects operational work across:

- project / product;
- sprint or front;
- issue / story;
- responsible agent or owner;
- branch, PR, CI, and execution workspace evidence;
- JP approval gate and Guardião boundary.

Paperclip remains the operational cockpit. Obsidian remains the curated memory for decisions, validation notes, and strategic context. The Command Center should show what is happening now and what needs a human or safety decision next.

## MVP scope

The first slice is intentionally read-only and derived from existing Paperclip structures:

- projects provide product/project grouping;
- issues provide active work, status, priority, ownership, run/workspace references, and next-action state;
- agents resolve responsible owner labels when an issue has an agent assignee;
- blocked issues are shown as Guardião boundary items;
- in-review issues are shown as JP approval gates;
- in-progress or run-linked issues are shown as active agent execution;
- unassigned work stays visible as ownership-needed work.

No schema migration is required for this MVP. The v1 trace is built by typed UI helpers over the existing project/issue/agent API responses.

## Safety boundaries

This page must not expose secrets, cookies, session data, database URLs, tokens, or auth material. It must not provide broad live command execution. Any future actions that can start/stop work, run shell commands, create PRs, merge, deploy, publish, or expose Paperclip publicly must stay behind explicit approval gates and any applicable Guardião review.

## Later automation

Later slices can add richer traceability after product validation:

- explicit front/sprint model or tags;
- first-class branch/PR/CI fields;
- gate state history;
- approval request cards linked to issues;
- CI/provider integrations;
- safe one-click transitions for narrow, audited workflow actions.

If these require schema/API changes, write the data-model recommendation first and synchronize contracts across `packages/db`, `packages/shared`, `server`, and `ui` before migrating.
