// Explicit allowlist of Claude Code tools we permit when running inside a
// sandbox. We use this instead of `--dangerously-skip-permissions` for sandbox
// targets because the permission-approval prompts can't be answered by a
// human inside a non-interactive sandbox, but blanket-allowing every tool
// would defeat the point of having a separate sandbox code path.
//
// Maintenance: this list must be reviewed when Claude Code releases a new
// tool. The canonical list of built-in tools is documented at
// https://docs.claude.com/en/docs/claude-code/built-in-tools — when a tool
// is added there, decide whether it should be allowed in sandbox runs and
// either add it here or document the deliberate exclusion. Omitting a tool
// silently disables it inside sandboxes, which can look like the tool is
// "broken" rather than intentionally gated.
const SANDBOX_ALLOWED_TOOLS =
  "Task AskUserQuestion Bash(*) CronCreate CronDelete CronList Edit " +
  "EnterPlanMode EnterWorktree ExitPlanMode ExitWorktree Glob Grep Monitor " +
  "NotebookEdit PushNotification Read RemoteTrigger ScheduleWakeup Skill " +
  "TaskOutput TaskStop TodoWrite ToolSearch WebFetch WebSearch Write";

export function buildClaudeProbePermissionArgs(input: {
  dangerouslySkipPermissions: boolean;
  targetIsSandbox: boolean;
}): string[] {
  if (!input.dangerouslySkipPermissions) return [];
  // For sandbox targets, mirror the execution path: pass `--allowedTools`
  // with the curated allowlist instead of dropping the flag entirely. The
  // hello probe is a one-shot prompt that should never trigger a tool, but
  // if a future probe prompt does, we don't want Claude CLI to stall on an
  // interactive permission prompt that no human can answer.
  if (input.targetIsSandbox) return ["--allowedTools", SANDBOX_ALLOWED_TOOLS];
  return ["--dangerously-skip-permissions"];
}

export function buildClaudeExecutionPermissionArgs(input: {
  dangerouslySkipPermissions: boolean;
  targetIsSandbox: boolean;
}): string[] {
  if (!input.dangerouslySkipPermissions) return [];
  if (input.targetIsSandbox) {
    return ["--allowedTools", SANDBOX_ALLOWED_TOOLS];
  }
  return ["--dangerously-skip-permissions"];
}
