CREATE UNIQUE INDEX IF NOT EXISTS execution_workspaces_active_adopted_cwd_idx
  ON execution_workspaces (company_id, COALESCE(provider_ref, cwd))
  WHERE status <> 'archived'
    AND closed_at IS NULL
    AND provider_type = 'git_worktree'
    AND strategy_type = 'git_worktree'
    AND metadata ? 'adoption'
    AND COALESCE(provider_ref, cwd) IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS execution_workspaces_active_adopted_full_branch_idx
  ON execution_workspaces (company_id, (metadata->>'fullBranchRef'))
  WHERE status <> 'archived'
    AND closed_at IS NULL
    AND provider_type = 'git_worktree'
    AND strategy_type = 'git_worktree'
    AND metadata ? 'adoption'
    AND metadata->>'fullBranchRef' IS NOT NULL;
