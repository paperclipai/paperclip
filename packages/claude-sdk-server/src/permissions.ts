// Claude rejects `--dangerously-skip-permissions` when it is running as root
// or under sudo. In that case we fall back to an explicit allowlist so the
// bridge can still run non-interactively without requiring manual approvals.
export const ELEVATED_ALLOWED_TOOLS =
  "Task AskUserQuestion Bash(*) CronCreate CronDelete CronList Edit " +
  "EnterPlanMode EnterWorktree ExitPlanMode ExitWorktree Glob Grep Monitor " +
  "NotebookEdit PushNotification Read RemoteTrigger ScheduleWakeup Skill " +
  "TaskOutput TaskStop TodoWrite ToolSearch WebFetch WebSearch Write";

export function isElevatedExecution(env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof process.getuid === "function" && process.getuid() === 0) return true;
  return (
    (typeof env.SUDO_USER === "string" && env.SUDO_USER.trim().length > 0) ||
    (typeof env.SUDO_UID === "string" && env.SUDO_UID.trim().length > 0)
  );
}

export function buildClaudeExecutionPermissionArgs(input: {
  dangerouslySkipPermissions: boolean;
  elevatedExecution?: boolean;
}): string[] {
  if (!input.dangerouslySkipPermissions) return [];
  if (input.elevatedExecution ?? isElevatedExecution()) {
    return ["--allowedTools", ELEVATED_ALLOWED_TOOLS];
  }
  return ["--dangerously-skip-permissions"];
}
