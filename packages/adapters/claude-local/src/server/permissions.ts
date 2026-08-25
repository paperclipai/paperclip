import { createRequire } from "node:module";
import path from "node:path";
import type { ResolvedRuntimeToolPolicy } from "@paperclipai/adapter-utils";

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

const BLIND_JUDGE_FILE_TOOLS = "Edit Glob Grep Read TodoWrite Write";
const BLIND_JUDGE_PAPERCLIP_TOOLS =
  "mcp__paperclip__paperclipGetDocument " +
  "mcp__paperclip__paperclipListDocumentRevisions " +
  "mcp__paperclip__paperclipComputeSha256 " +
  "mcp__paperclip__paperclipAddCurrentTaskComment " +
  "mcp__paperclip__paperclipSetCurrentTaskVerdict";
const BLIND_JUDGE_DISALLOWED_TOOLS =
  "Agent AskUserQuestion Bash CronCreate CronDelete CronList EnterPlanMode " +
  "EnterWorktree ExitPlanMode ExitWorktree Monitor NotebookEdit PushNotification " +
  "RemoteTrigger ScheduleWakeup SendMessage Skill Task TaskOutput TaskStop ToolSearch " +
  "WebFetch WebSearch";
const BLIND_JUDGE_EMPTY_MCP_CONFIG = '{"mcpServers":{}}';
const require = createRequire(import.meta.url);
const PAPERCLIP_MCP_STDIO_PATH = (() => {
  try {
    return require.resolve("@paperclipai/mcp-server/blind-judge-stdio");
  } catch {
    const packageEntry = require.resolve("@paperclipai/mcp-server");
    return path.resolve(path.dirname(packageEntry), "../dist/blind-judge-stdio.js");
  }
})();

function shouldUseAllowedTools(input: { targetIsRemote: boolean; localProcessUid?: number | null }): boolean {
  // Claude Code refuses `--dangerously-skip-permissions` when the process runs
  // as root. Use the same explicit allowlist that remote targets use so local
  // Docker/root probes and executions fail safe instead of hard-failing before
  // auth/runtime validation can complete.
  return input.targetIsRemote || input.localProcessUid === 0;
}

function blindJudgeMcpConfig(policy: ResolvedRuntimeToolPolicy): string {
  return JSON.stringify({
    mcpServers: {
      paperclip: {
        command: process.execPath,
        args: [PAPERCLIP_MCP_STDIO_PATH],
        env: {
          PAPERCLIP_MCP_TOOL_PROFILE: "blind_judge",
          PAPERCLIP_MCP_ALLOWED_READ_ISSUE_IDS: (policy.paperclipReadIssueIds ?? []).join(","),
        },
      },
    },
  });
}

function restrictedRuntimeArgs(input: {
  policy?: ResolvedRuntimeToolPolicy | null;
  targetIsRemote: boolean;
}): string[] | null {
  const { policy, targetIsRemote } = input;
  if (policy?.profile !== "blind_judge") return null;
  const paperclipTools = targetIsRemote ? "" : BLIND_JUDGE_PAPERCLIP_TOOLS;
  const allowedTools = [BLIND_JUDGE_FILE_TOOLS, paperclipTools].filter(Boolean).join(" ");
  return [
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    targetIsRemote ? BLIND_JUDGE_EMPTY_MCP_CONFIG : blindJudgeMcpConfig(policy),
    "--disable-slash-commands",
    "--no-chrome",
    "--no-session-persistence",
    "--tools",
    BLIND_JUDGE_FILE_TOOLS,
    "--allowedTools",
    allowedTools,
    "--disallowedTools",
    BLIND_JUDGE_DISALLOWED_TOOLS,
    "--permission-mode",
    "dontAsk",
  ];
}

export function buildClaudeProbePermissionArgs(input: {
  dangerouslySkipPermissions: boolean;
  targetIsRemote: boolean;
  localProcessUid?: number | null;
  runtimeToolPolicy?: ResolvedRuntimeToolPolicy | null;
}): string[] {
  const restricted = restrictedRuntimeArgs({
    policy: input.runtimeToolPolicy,
    targetIsRemote: input.targetIsRemote,
  });
  if (restricted) return restricted;
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
  runtimeToolPolicy?: ResolvedRuntimeToolPolicy | null;
}): string[] {
  const restricted = restrictedRuntimeArgs({
    policy: input.runtimeToolPolicy,
    targetIsRemote: input.targetIsRemote,
  });
  if (restricted) return restricted;
  if (!input.dangerouslySkipPermissions) return [];
  if (shouldUseAllowedTools(input)) {
    return ["--allowedTools", SANDBOX_ALLOWED_TOOLS];
  }
  return ["--dangerously-skip-permissions"];
}
