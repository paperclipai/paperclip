export type WorkspaceOperationPhase =
  | "worktree_prepare"
  | "workspace_config_freshness"
  | "workspace_provision"
  | "workspace_seed"
  | "workspace_runtime_provision"
  | "workspace_repair"
  | "workspace_teardown"
  | "worktree_cleanup"
  | "workspace_finalize"
  /**
   * A provider tool call observed through adapter runtime events while a
   * legacy (non-native) adapter executed: file edits, shell commands, git
   * actions, and read-only tool calls alike. Recorded as the events arrive so
   * a run that died mid-execution still shows the work that was in flight or
   * already applied, which is what makes "zero recorded operations" a true
   * statement about zero writes.
   */
  | "provider_tool_execution";

export type WorkspaceOperationStatus = "running" | "succeeded" | "failed" | "skipped";

export interface WorkspaceOperation {
  id: string;
  companyId: string;
  executionWorkspaceId: string | null;
  heartbeatRunId: string | null;
  issueId: string | null;
  phase: WorkspaceOperationPhase;
  command: string | null;
  cwd: string | null;
  status: WorkspaceOperationStatus;
  exitCode: number | null;
  logStore: string | null;
  logRef: string | null;
  logBytes: number | null;
  logSha256: string | null;
  logCompressed: boolean;
  stdoutExcerpt: string | null;
  stderrExcerpt: string | null;
  metadata: Record<string, unknown> | null;
  startedAt: Date;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
