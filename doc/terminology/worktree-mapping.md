# Worktree terminology and legacy contracts

Paperclip calls the product concept a **worktree**. Until the Phase 2 contract decision, integrations must continue to use the legacy **workspace** names at persisted and process/network boundaries.

| Product term | Phase 1 contract name |
| --- | --- |
| Worktree | `workspace` |
| Project worktree | `project_workspace` / `projectWorkspace*` / `/projects/:id/workspaces` |
| Execution worktree | `execution_workspace` / `executionWorkspace*` / `/execution-workspaces` |
| Worktree environment | `PAPERCLIP_WORKSPACE_*` and `PAPERCLIP_WORKSPACES_JSON` |
| Worktree permission | `project.workspaces.*` and `execution.workspaces.*` |
| Worktree plugin capability | SDK and manifest `workspace*` names, including `workspace-diff` |

These spellings are compatibility contracts, not preferred product copy. Database table, column, index, and constraint names also remain unchanged in Phase 1.
