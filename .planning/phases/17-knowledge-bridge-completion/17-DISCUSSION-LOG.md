# Phase 17: Knowledge Bridge Completion - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md.

**Date:** 2026-04-25
**Phase:** 17 - Knowledge Bridge Completion
**Areas discussed:** source of truth, import behavior, operator workflow, evidence status

---

## Source of Truth

| Option | Description | Selected |
|--------|-------------|----------|
| Event/projector primary | DB/event projector remains truth; markdown is export/import-preview artifact | ✓ |
| Markdown vault primary | Obsidian files become write path | |

**Auto choice:** Event/projector primary.
**Notes:** This follows AGENTS.md and prior Phase 5/11 decisions.

---

## Import Behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Import preview | Validate vault frontmatter and source event evidence without mutating business truth | ✓ |
| Bidirectional sync | Write imported markdown back to RT2 storage | |

**Auto choice:** Import preview.
**Notes:** Safe for this phase and still satisfies operator-visible import workflow.

---

## Operator Workflow

| Option | Description | Selected |
|--------|-------------|----------|
| One bridge view | Projection, export, import preview, graph report, evidence status in one flow | ✓ |
| Separate pages | Split every operation into independent screens | |

**Auto choice:** One bridge view.

---

## Evidence Status

| Option | Description | Selected |
|--------|-------------|----------|
| Explicit statuses | `ready`, `missing`, `stale`, `ambiguous` shown beside graph confidence | ✓ |
| Raw counts only | Show node/edge/file counts without evidence interpretation | |

**Auto choice:** Explicit statuses.

## Deferred Ideas

- Actual local Obsidian writer.
- Bidirectional sync with conflict resolution.
