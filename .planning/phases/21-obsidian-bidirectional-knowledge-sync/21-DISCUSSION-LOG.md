# Phase 21: Obsidian Bidirectional Knowledge Sync - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md.

**Date:** 2026-04-25  
**Phase:** 21 - Obsidian Bidirectional Knowledge Sync  
**Mode:** `--auto --chain`

## Source-of-truth Boundary

| Option | Description | Selected |
|--------|-------------|----------|
| RT2 canonical | RT2 DB/event/wiki/graph remain canonical and vault is an approved sync surface | yes |
| Vault canonical | Obsidian files become the write path | no |

**Auto-selected:** RT2 canonical.

## Writer Behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Dry-run guarded writer | Save path/settings and show conflict risk without unsafe server-side desktop writes | yes |
| Direct filesystem writer | Server writes directly into local vault path | no |

**Auto-selected:** Dry-run guarded writer.

## Import Behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Approved candidates only | Split wiki/node/edge candidates and apply only selected changes | yes |
| Apply all previewed files | Bulk write every imported markdown file | no |

**Auto-selected:** Approved candidates only.

## Conflict Behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Three-way operator decision | `rt2_wins`, `vault_wins`, `manual_merge` with audit reason | yes |
| Last-write-wins | Most recent timestamp wins automatically | no |

**Auto-selected:** Three-way operator decision.

## Deferred Ideas

- Native local vault writer daemon.
- Continuous file watcher.
