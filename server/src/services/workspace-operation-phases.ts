import type { WorkspaceOperationPhase } from "@paperclipai/shared";

export const LOCAL_WORKSPACE_COMMAND_PHASES: readonly WorkspaceOperationPhase[] = ["worktree_prepare",
  "workspace_config_freshness", "workspace_provision", "workspace_seed", "workspace_runtime_provision",
  "workspace_repair", "workspace_teardown", "worktree_cleanup"];
