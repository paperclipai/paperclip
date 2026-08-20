# Operator Guide: Hierarchical Agent Folders

**Audience:** Fleet operators who manage 10+ agents across teams, roles, or
projects.  
**Status:** stable (JAC-4746)  
**Spec reference:** `doc/SPEC-implementation.md` §7.18

---

## Overview

Agent folders let you group agents into a hierarchical tree and cascade
folder-level shared instructions down to every agent in that subtree. This is
the primary mechanism for managing instructions at scale — instead of editing
100 individual `AGENTS.md` files, you write once in a folder and every agent
in that folder inherits it.

Folder-level instructions are **separate from** (and layered under) the agent's
own instruction files. An agent can override its folder's instructions by
providing its own pointer file.

---

## 1. Creating a Folder Hierarchy

### Via the API

```bash
curl -X POST "$PAPERCLIP_API_URL/api/companies/$COMPANY_ID/agent-folders" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Engineering"}'

# Create a nested folder
curl -X POST "$PAPERCLIP_API_URL/api/companies/$COMPANY_ID/agent-folders" \
  -d '{"name": "Backend", "parentId": "<parent-folder-id>"}'
```

### Via the CLI

The `paperclipai folder` command group covers common operations. See
`doc/CLI.md` for the full reference or run `paperclipai folder --help`.

### Naming and slugs

- **Slug**: auto-generated from the name (lowercase, hyphenated) unless you
  provide one explicitly. Slugs are unique within a company under a given
  parent.
- **Same slug is allowed under different parents** — `Engineering/Backend` and
  `Design/Backend` can both exist.
- **Sort order**: folders are ordered by `sort_order` then `name` then `id`.
  Set it explicitly when order matters.

### Recommended hierarchy

```
Root (Company-wide)
├── Engineering
│   ├── Backend
│   └── Frontend
├── Design
├── Operations
│   ├── Coordinators
│   └── Watchdogs
└── QA
```

---

## 2. Writing Folder-Level Instructions

Folder-level shared instructions live on disk at:

```
~/.paperclip/instances/default/companies/<companyId>/folders/<folderId>/instructions/AGENTS.md
```

1. Create the folder via API/CLI first (this gives you the `folderId`).
2. Create the instructions directory and `AGENTS.md`:

```bash
mkdir -p ~/.paperclip/instances/default/companies/$COMPANY_ID/folders/$FOLDER_ID/instructions
cat > ~/.paperclip/instances/default/companies/$COMPANY_ID/folders/$FOLDER_ID/instructions/AGENTS.md << 'EOF'
# Engineering Team Instructions

- Follow the team coding standard in `STANDARD.md`.
- PR reviews require at least 1 approver from the same team.
- Use the staging environment for integration testing.
EOF
```

3. Any additional `.md` files in the `instructions/` directory are also
   included in the cache fingerprint (so editing them invalidates the cache),
   but only `AGENTS.md` is merged as the folder-level instruction bundle.

### Resolution order

When an agent resolves its instructions, the merger walks the folder chain from
the agent's immediate folder up to the root (leaf-to-root order). This means:

- **Child folder instructions take precedence** over parent folder instructions
  (child content appears first in the merged result).
- The agent's own override pointer file (if present) takes the **highest**
  precedence and is prepended at merge time.

---

## 3. Adding Agents to Folders

### Bulk assignment

```bash
curl -X POST "$PAPERCLIP_API_URL/api/companies/$COMPANY_ID/agent-folders/$FOLDER_ID/agents" \
  -d '{"agentIds": ["agent-uuid-1", "agent-uuid-2"]}'
```

### Single agent move (or unassign)

```bash
# Move to a folder
curl -X POST "$PAPERCLIP_API_URL/api/companies/$COMPANY_ID/agent-folders/agents/$AGENT_ID/move" \
  -d '{"folderId": "<folder-id>"}'

# Unassign (set folder_id to NULL)
curl -X POST "$PAPERCLIP_API_URL/api/companies/$COMPANY_ID/agent-folders/agents/$AGENT_ID/move" \
  -d '{"folderId": null}'
```

### Agent overrides

If an agent needs custom instructions that override the folder-level bundle:

1. Write the agent-specific content to the pointer file:
   `.../folders/<folderId>/instructions/<agentId>.md`
2. The content of this file **replaces** the inherited folder instructions
   (it does not append). To layer on top of the folder bundle, include the
   relevant folder instructions in the pointer file or use the folder-level
   `AGENTS.md` + agent-specific overrides pattern.

If you want the agent to inherit folder instructions verbatim (no override),
the service writes a zero-override marker pointer file automatically when you
assign the agent. You can also remove the pointer file and the agent will use
the pure-DB pointer (the `folder_id` column).

---

## 4. Migrating Existing Agents

If you have agents already running without folders (flat organization), you
can migrate them in bulk.

### Dry run (preview)

```bash
paperclipai folder migrate-from-flat --dry-run
```

This shows a preview: how many flat agents exist and how they'd be grouped
by role (or by a metadata key).

### Role-based migration

```bash
paperclipai folder migrate-from-flat
```

This creates one folder per distinct agent role (e.g., `coordinator`,
`watchdog`, `general`) and assigns all flat agents to their role folder.
**Idempotent**: running it again does nothing if all agents already have
folders.

### Metadata-key migration

```bash
paperclipai folder migrate-from-flat --group-by team
```

Groups flat agents by the `team` key in their `metadata` jsonb field. Agents
without the key go into an `unspecified` folder.

### Custom migration

```bash
paperclipai folder migrate-to-folder --folder-name "Special Ops" \
  --agent-ids "agent-uuid-1,agent-uuid-2,agent-uuid-3"
```

Creates (or reuses) a folder named "Special Ops" and assigns the listed agents.

### Rollback / unassign

```bash
paperclipai folder unassign --agent-ids "agent-uuid-1,agent-uuid-2"
# or unassign all agents from a folder:
paperclipai folder unassign --agent-ids all
```

> **Note:** `unassign` takes agent IDs, not a folder ID. To unassign all agents
> from a specific folder, first list them with
> `GET /agent-folders/:folderId/agents`, then unassign.

---

## 5. Validating the Inheritance Chain

Before or after migration, validate that the folder structure is sound:

```bash
paperclipai folder validate-inheritance
```

This checks for:

| Issue type | Description |
|---|---|
| Broken folder references | Agents pointing to a folder that doesn't exist in the DB |
| Broken folder chains | Folders whose parent has been deleted (orphaned) |
| Folder cycles | A → B → A or any circular parent chain |
| Missing instructions | Agents in a folder that has no `AGENTS.md` yet |
| Conflicting external + folder instructions | Agent has both an external instructions file and folder-level instructions |
| Misaligned instructions roots | Agent's `adapterConfig.instructionsRootPath` doesn't match the expected folder path |

Fix any issues reported before relying on folder inheritance in production.

---

## 6. Performance Considerations for 100+ Agents

- **Advisory locking**: Mutating operations (create, update, move, delete) on
  agent folders acquire a Postgres advisory lock per company. This serializes
  folder mutations within a company to prevent race conditions. Plan for
  low-concurrency on mutations.

- **Recursive listing**: `GET /agent-folders/:folderId/agents` recursively
  walks the entire descendant subtree. For 100+ agents in a single folder, the
  result set is bounded by the total agent count — not a performance concern,
  but the listing is not paginated.

- **Cache invalidation**: The fingerprint cache is process-scoped (in-memory).
  Restarting the Paperclip server clears all cached merges. File mtime + content
  hash comparison ensures stale cache entries are detected even across
  long-running processes. For multi-server deployments, each server maintains
  its own cache and invalidates via file mtimes.

- **Agent count per folder**: Tested with 100 agents in a single folder. For
  fleets >500, consider splitting into sub-folders by team/sub-team to keep
  listing and instruction-resolution fast.

- **Instruction merge**: Merging is O(depth) per agent — walking the folder
  chain. With 5+ levels of nesting, this is still sub-millisecond. The merge
  result is cached per (company, folder-chain, agent-instructions-hash).

- **Moving folders**: `moveFolder` adjusts sibling slugs if a conflict arises.
  After a move, descendants' pointer files are not rewritten (they remain on
  the original folder's directory until the agent is reassigned). This is
  because the pointer file path is tied to the folder, not the agent's new
  location — the DB `folder_id` is the source of truth.

---

## 7. Folder Management Reference

| Action | Tool |
|---|---|
| List folders | `GET /companies/:cid/agent-folders` |
| Create folder | `POST /companies/:cid/agent-folders` |
| Get folder | `GET /companies/:cid/agent-folders/:id` |
| Update folder | `PATCH /companies/:cid/agent-folders/:id` |
| Move folder | `POST /companies/:cid/agent-folders/:id/move` |
| Delete folder | `DELETE /companies/:cid/agent-folders/:id` |
| Assign agents | `POST /companies/:cid/agent-folders/:id/agents` |
| List agents (recursive) | `GET /companies/:cid/agent-folders/:id/agents` |
| Move single agent | `POST /companies/:cid/agent-folders/agents/:id/move` |
| Migrate flat agents | `POST /companies/:cid/folders/migrate-by-role` (board only) |
| Validate inheritance | `POST /companies/:cid/folders/validate-inheritance` (board only) |

---

## 8. Troubleshooting

### "Folder slug already exists under this parent"

Two folders under the same parent cannot have the same slug. Rename one or
choose a different parent.

### "Move or delete nested folders first"

You cannot delete a folder that has child folders. Move children to a new
parent first, or delete them individually.

### "A folder cannot be moved into its own subtree"

This is cycle prevention. You cannot make a folder its own ancestor. Reorganize
your hierarchy differently.

### Agent not seeing new folder instructions

1. Run `paperclipai folder validate-inheritance` to check for broken refs or
   missing `AGENTS.md`.
2. Verify the instructions directory path matches the expected pattern:
   `~/.paperclip/instances/default/companies/<cid>/folders/<fid>/instructions/AGENTS.md`
3. If using `PAPERCLIP_INSTANCE_ROOT`, ensure it's set consistently on the
   server that resolves instructions.

### Tests fail with "duplicate key value violates unique constraint on issue_prefix"

When running integration tests, each test creates a company with a unique
`issue_prefix`. If two tests use the same prefix, the second insert fails.
Ensure each test uses a unique prefix (e.g., `CXY` instead of `C2`).
