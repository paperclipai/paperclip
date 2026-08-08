# JAC-4746: Hierarchical Agent Folder Structure

**Status:** implementation_complete
**Date:** 2026-08-04
**Paperclip issue:** JAC-4746
**Audience:** Engineering
**Branch:** `JAC-4746-implement-hierarchical-agent-folder-structure-for-paperclip-fleet`

## Goal

Implement a hierarchical agent folder structure in Paperclip so that folder-level
shared instructions cascade to all agents in that folder, enabling efficient
management of 100+ agent fleets.

## Design Decisions

- New `agent_folders` table with self-referential hierarchy (`parentId` → `agent_folders.id`)
- `agents.folder_id` column (nullable FK → `agent_folders.id`, ON DELETE SET NULL)
- Folder instructions stored on disk at:
  `<instanceRoot>/companies/<cid>/folders/<fid>/instructions/`
- Pointer files for agents with overrides; pure-DB pointers for zero-override agents
- Pre-merge on server with fingerprint-based caching
- `folder_id` is separate from `reportsTo` (instruction inheritance ≠ org hierarchy)

## Open Questions (from swarm)

1. **Per-instance memory location** — RESOLVED: Use `<instanceRoot>/companies/<cid>/folders/` for instruction files; metadata lives in the DB. No Hindsight/Honcho integration at this layer.
2. **Generic vs per-role adapter script** — RESOLVED: Generic approach. The `folder_id` column and instructions are adapter-agnostic; adapter-specific resolution happens in the existing `agentInstructionsService`.
3. **Ordinal vs scalar privilege values** — Out of scope for this issue. Privilege model is unchanged.

## Implementation Phases

### Phase 0 — Schema (non-breaking) ✅
- **JAC-4747**: `agent_folders` table + `folder_id` on agents

### Phase 1 — Folder CRUD + Instructions
- **JAC-4748**: Folder CRUD service + REST API (create, read, update, delete, tree, cycle detection)
- **JAC-4749**: Folder instructions filesystem + service

### Phase 2 — Inheritance Engine
- **JAC-4750**: Instruction inheritance resolution (chain walking, merge, caching)
- **JAC-4751**: Adapter integration — use merged instructions in hermes_local/claude_local

### Phase 3 — Agent Integration + CLI
- **JAC-4752**: Pointer files + agent integration (folderId on create/update, inheritance metadata)
- **JAC-4753**: CLI commands for folder management

### Phase 4 — Migration + Testing
- **JAC-4754**: Migration tooling (flat-to-folder migration script)
- **JAC-4755**: Integration tests + documentation

### Pre-Implementation Decision
- **JAC-4756**: Resolve open questions

## Data Model

```
agent_folders
  id          uuid PK
  company_id  uuid FK → companies.id (ON DELETE CASCADE)
  parent_id   uuid FK → agent_folders.id (ON DELETE SET NULL)
  name        text
  slug        text
  sort_order  integer
  metadata    jsonb  -- folder-level shared instructions
  created_at  timestamp
  updated_at  timestamp

agents
  ...existing columns...
  folder_id   uuid FK → agent_folders.id (ON DELETE SET NULL)
```

## Instruction Resolution

1. Agent may have its own instructions file (pointer file)
2. If not, resolve parent folder chain and merge instructions
3. Fingerprint cached result to avoid re-merge
4. Disk path: `<instanceRoot>/companies/<cid>/folders/<fid>/instructions/`

## Acceptance Criteria

1. ✅ Agent folders CRUD API works (list, create, get, update, delete, move)
2. ✅ Agents can be assigned to a folder via `folder_id`
3. ✅ Folder instructions cascade to agents in the folder
4. ✅ Agents with overrides use pointer files; zero-override agents use pure-DB pointers
5. ✅ Server pre-merges with fingerprint-based caching
6. ✅ Schema, types, validators, routes, and services are synchronized
7. ✅ Typecheck, tests, and build pass
