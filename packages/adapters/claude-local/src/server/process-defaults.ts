import { asBoolean } from "@paperclipai/adapter-utils/server-utils";

export function isPaperclipRunningAsRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

/**
 * Claude CLI rejects --dangerously-skip-permissions when the process runs as root.
 * On uid 0 this is always false, even when adapterConfig or the UI default sets it to true.
 */
export function resolveDangerouslySkipPermissions(configValue: unknown): boolean {
  if (isPaperclipRunningAsRoot()) return false;
  return asBoolean(configValue, true);
}

/**
 * Without --dangerously-skip-permissions, Claude requires per-tool approval; in --print mode there is no user to approve.
 * Passing an explicit allowlist pre-approves these tools (verified for root + Bash/curl to Paperclip API).
 * Extend via adapter `extraArgs` with your own `--allowed-tools` (then this default is not injected).
 * MCP tool names vary by server; add them in extraArgs if needed (e.g. `mcp__openclaw__messages_send`).
 */
export const CLAUDE_ROOT_HEADLESS_ALLOWED_TOOLS =
  [
    "Bash(*)",
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "Monitor",
    "WebFetch",
    "WebSearch",
    "Skill",
    "Task",
    "TaskOutput",
    "TaskStop",
    "ToolSearch",
    "TodoWrite",
    "NotebookEdit",
    "AskUserQuestion",
    "CronCreate",
    "CronDelete",
    "CronList",
    "RemoteTrigger",
    "EnterPlanMode",
    "ExitPlanMode",
    "EnterWorktree",
    "ExitWorktree",
  ].join(",");

export function argvIncludesAllowedToolsFlag(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--allowed-tools" || a === "--allowedTools") return true;
    if (a.startsWith("--allowed-tools=") || a.startsWith("--allowedTools=")) return true;
  }
  return false;
}

/** When root cannot use --dangerously-skip-permissions, inject --allowed-tools unless the operator set it in extraArgs. */
export function shouldInjectRootHeadlessAllowedTools(
  dangerouslySkipPermissions: boolean,
  extraArgs: readonly string[],
): boolean {
  if (!isPaperclipRunningAsRoot() || dangerouslySkipPermissions) return false;
  return !argvIncludesAllowedToolsFlag(extraArgs);
}
