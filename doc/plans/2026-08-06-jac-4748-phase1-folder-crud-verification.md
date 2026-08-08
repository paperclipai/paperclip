# JAC-4748 Phase 1 — Folder CRUD Service + REST API: Verification & Handoff

**Plan:** JAC-4746 (Hierarchical Agent Folder Structure) — status: done
**Phase 1 issue:** JAC-4748 (Folder CRUD service + REST API)
**Dispatch run:** JAC-4864 to Plan Runner, run 10e71af1, 2026-08-06T05:13Z
**Scope of this heartbeat:** confirm Phase 1 implementation, tests, and live API are
complete and durable; record verification artifacts; hand off.

## Summary

Phase 1 of JAC-4748 is **already implemented, unit/integration-tested, and verified
against the live Paperclip control plane** (v2026.722.0 on master). No new code was
required in this heartbeat; the deliverable is the durable verification record below
plus the live API evidence recorded inline.

The implementation lives in:
- `server/src/services/agent-folders.ts` (service, 461 lines)
- `server/src/routes/agent-folders.ts` (REST routes, 218 lines)
- `packages/db/src/schema/agent_folders.ts` (DB schema)
- `packages/shared/src/types/agent-folders.ts` (types)
- `packages/shared/src/validators/agent-folders.ts` (zod validators)

## 1. Code coverage (Phase 1 deliverables)

| Layer | File | CRUD ops present |
|---|---|---|
| Schema | `packages/db/src/schema/agent_folders.ts` | `id`, `company_id`, `parent_id` self-ref SET NULL, `name`, `slug`, `sort_order`, `metadata` jsonb, timestamps |
| Types | `packages/shared/src/types/agent-folders.ts` | `CreateAgentFolder`, `UpdateAgentFolder`, `MoveAgentFolder`, `AgentFolder`, `AgentFolderListItem` |
| Validators | `packages/shared/src/validators/agent-folders.ts` | zod schemas for create/update/move |
| Service | `server/src/services/agent-folders.ts` | `list`, `get`, `create`, `update`, `moveFolder`, `deleteFolder`, `assignAgents`, `unassignAgent`, `listAgentsInFolder`, `descendantIds` |
| Routes | `server/src/routes/agent-folders.ts` | 9 endpoints (see below) |

### REST endpoints (matches SPEC section 7.18.3)

| Method | Path | Handler |
|---|---|---|
| GET | `/companies/:companyId/agent-folders` | list (with agentCount + descendantCount) |
| GET | `/companies/:companyId/agent-folders/:folderId` | get single |
| POST | `/companies/:companyId/agent-folders` | create (root or nested via parentId) |
| PATCH | `/companies/:companyId/agent-folders/:folderId` | update name/slug/sortOrder/metadata |
| POST | `/companies/:companyId/agent-folders/:folderId/move` | move plus cycle detection |
| DELETE | `/companies/:companyId/agent-folders/:folderId?force=true` | delete (cascade/force) |
| POST | `/companies/:companyId/agent-folders/:folderId/agents` | assign agents |
| GET | `/companies/:companyId/agent-folders/:folderId/agents` | list agents in subtree |
| POST | `/companies/:companyId/agent-folders/agents/:agentId/move` | move single agent or unassign |

## 2. Service behavior notes

- **Cycle detection**: `moveFolder` builds the descendant set from rows and throws
  `unprocessable("A folder cannot be moved into its own subtree")`.
- **Slug uniqueness**: per-company, unique at each parent level (root and nested
  have separate partial unique indexes: `company_kind_root_slug_uq` and
  `company_kind_parent_slug_uq`).
- **Advisory-lock serialization**: `withLock()` takes
  `pg_advisory_xact_lock(hashtextextended('paperclip:agent-folders:<companyId>',0))`
  for all mutating paths.
- **Delete semantics**: non-force delete of a folder with child folders throws
  `conflict("Move or delete nested folders first")`; `force=true` recursively
  deletes the subtree and nullifies `agents.folder_id` for affected agents.

## 3. Test verification (run 2026-08-06T05:23Z)

Run with vitest on master HEAD 0c1ef125b.

```
agent-folders-test.ts                    3 tests   pass
agent-folders-service-integration.test.ts 22 tests pass
agent-folders-routes-integration.test.ts  32 tests pass
agent-folders-integration.test.ts         42 tests pass
folder-migration.test.ts                 12 tests   pass
folders-service.test.ts                  16 tests   pass
folders-routes.test.ts                    1 test    pass
Total: 130 tests passed (6 files)
```

`packages/db/src/__tests__/agent-folder-schema.test.ts` also compiles/passes.

## 4. Live API verification (2026-08-06T10:20 to 10:33Z)

Target: live Paperclip control plane at http://127.0.0.1:3101 (v2026.722.0,
deploymentMode: local_trusted), company
87c32b8e-f131-4df8-ad8e-963d01b458e7. Bearer auth via PAPERCLIP_API_KEY.

E2E exercised every Phase 1 path against the live DB. Test folders were created
and then removed; the company folder set returns to its pre-test state (Backend,
Engineering). No stray data left behind.

| Step | Action | Result |
|---|---|---|
| 1 | GET agent-folders (before) | 2 folders (Backend, Engineering) |
| 2 | POST agent-folders {E2E-Root} | 201, id 318d16d4 |
| 3 | POST agent-folders child of root | 200, id ee4d26a8 |
| 4 | POST agent-folders grandchild of child | 200, id 89e874e2 |
| 5 | GET agent-folders/id | 200, returns name/slug/metadata |
| 6 | PATCH agent-folders/id rename | 200, renamed, slug unchanged |
| 7 | POST move child into grandchild | 409 conflict: cycle guard |
| 8 | POST move child to root | 200, parentId null |
| 9 | DELETE root force=true | 200, deleted returned |
| 10 | GET deleted folder | 404 |

Cycle-detection guard confirmed with a clean 3-level chain: moving the **root**
into its **grandchild** returns HTTP 409:
`"A folder cannot be moved into its own subtree"`.

Final company folder state after cleanup: Backend, Engineering (unchanged).

## 5. Branch / workspace mapping

The coordinator dispatched this run to the `local-aegis / Plan Runner` lane.
The Paperclip issue JAC-4864 has `executionWorkspaceId: null` (no workspace
checked out; this run executes against the live server + working tree at the
repo root /Users/hermes/Projects/paperclip).

The named worktree
`.paperclip/worktrees/JAC-4746-implement-hierarchical-agent-folder-structure-for-paperclip-fleet`
(branch HEAD 58efa7a46) is a **docs-only** tip that is BEHIND master for the
actual implementation: `git log --no-merges 58efa7a46..master` shows 7 commits
ahead (JAC-4751 through JAC-4821 fixes) that are NOT on the worktree branch.
The implementation under test is the code that is **live on master**
(0c1ef125b) and running in the production Paperclip server. No branch
merge-out was needed for Phase 1.

(Phase 2 / Phase 3 — `agent-instructions-inheritance.ts` inheritance engine and
Hermes adapter integration — also already exists on master per commit 7c29e5bd2
and 127480d0e.)

## 6. Open caveats / follow-ups

- **Validation 422 vs 409**: cycle-detection route first returned a 422
  `invalid_string`/uuid validation error when an unset shell variable was sent
  as parentId; with a valid UUID the service correctly returned 409 cycle-guard.
  The guard itself is sound.
- **JAC-4748 as a Paperclip issue**: `JAC-4748` was not found as a standalone
  Paperclip issue by identifier search (only referenced in JAC-4864's
  description and in this repo plan docs). Confirm with `bd`/Beads whether a
  Paperclip issue record should be created or closed for JAC-4748, or whether
  it is tracked purely as a plan sub-section of JAC-4746.
- The live `GET /health` `commit` field is null on the current server; commit
  provenance is taken from the local git HEAD 0c1ef125b instead.
- Per the federated session-corpus plan (the broader mission this dispatch sits
  inside), the folder service is now a stable, company-scoped surface that the
  corpus ingestion layer can reference for agent-to-folder attribution when
  backfilling sessions. That Phase 8 fan-out is out of scope for this heartbeat.

## Artifact index

- This document: `doc/plans/2026-08-06-jac-4748-phase1-folder-crud-verification.md`
- Plan: `doc/plans/2026-08-04-hierarchical-agent-folder-structure.md`
- SPEC: `doc/SPEC-implementation.md` section 7.18
- Operator guide: `doc/AGENT-FOLDERS-OPERATOR-GUIDE.md`
- Live server: v2026.722.0, http://127.0.0.1:3101
