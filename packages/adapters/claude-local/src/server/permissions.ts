// Explicit allowlist of Claude Code tools we permit when running on a remote
// target. We use this instead of `--dangerously-skip-permissions` for remote
// targets because the permission-approval prompts can't be answered by a
// human inside a non-interactive run, but blanket-allowing every tool would
// defeat the point of having a separate hosted/sandbox code path.
//
// Maintenance: this list must be reviewed when Claude Code releases a new
// tool. The canonical list of built-in tools is documented at
// https://docs.claude.com/en/docs/claude-code/built-in-tools — when a tool
// is added there, decide whether it should be allowed in remote runs and
// either add it here or document the deliberate exclusion. Omitting a tool
// silently disables it inside remote targets, which can look like the tool is
// "broken" rather than intentionally gated.
const SANDBOX_ALLOWED_TOOLS =
  "Task AskUserQuestion Bash CronCreate CronDelete CronList Edit " +
  "EnterPlanMode EnterWorktree ExitPlanMode ExitWorktree Glob Grep Monitor " +
  "NotebookEdit PushNotification Read RemoteTrigger ScheduleWakeup Skill " +
  "TaskOutput TaskStop TodoWrite ToolSearch WebFetch WebSearch Write";

// ADR-0029: CTO is the only infrastructure role. Engineer and Chief of Staff
// retain their narrower SSH mandates, but still receive the other deny-first
// protections applied to non-infrastructure roles.
const INFRA_ROLES = new Set(["cto"]);
const SSH_MANDATED_ROLES = new Set(["cto", "engineer", "pm"]);
const NON_INFRA_DENIED_TOOLS = ["mcp__*__exec", "Bash(rm -rf *)"];

function buildLocalDeniedTools(agentRole?: string | null): string {
  const normalizedRole = agentRole?.trim().toLowerCase() ?? "";
  if (INFRA_ROLES.has(normalizedRole)) return "";

  const deniedTools = [...NON_INFRA_DENIED_TOOLS];
  if (!SSH_MANDATED_ROLES.has(normalizedRole)) deniedTools.push("Bash(ssh *)");
  return deniedTools.join(" ");
}

function shouldUseAllowedTools(input: { targetIsRemote: boolean; localProcessUid?: number | null }): boolean {
  // Claude Code refuses `--dangerously-skip-permissions` when the process runs
  // as root. Use the same explicit allowlist that remote targets use so local
  // Docker/root probes and executions fail safe instead of hard-failing before
  // auth/runtime validation can complete.
  return input.targetIsRemote || input.localProcessUid === 0;
}

export function buildClaudeProbePermissionArgs(input: {
  dangerouslySkipPermissions: boolean;
  targetIsRemote: boolean;
  localProcessUid?: number | null;
}): string[] {
  if (!input.dangerouslySkipPermissions) return [];
  // For remote targets and local root processes, mirror the execution path:
  // pass `--allowedTools` with the curated allowlist instead of dropping the
  // flag entirely. The hello probe is a one-shot prompt that should never
  // trigger a tool, but if a future probe prompt does, we don't want Claude CLI
  // to stall on an interactive permission prompt that no human can answer.
  if (shouldUseAllowedTools(input)) return ["--allowedTools", SANDBOX_ALLOWED_TOOLS];
  return ["--dangerously-skip-permissions"];
}

export function buildClaudeExecutionPermissionArgs(input: {
  dangerouslySkipPermissions: boolean;
  targetIsRemote: boolean;
  localProcessUid?: number | null;
  agentRole?: string | null;
}): string[] {
  if (!input.dangerouslySkipPermissions) return [];
  if (shouldUseAllowedTools(input)) {
    return ["--allowedTools", SANDBOX_ALLOWED_TOOLS];
  }
  const deniedTools = buildLocalDeniedTools(input.agentRole);
  return [
    "--dangerously-skip-permissions",
    ...(deniedTools ? ["--disallowedTools", deniedTools] : []),
  ];
}
