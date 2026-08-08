import type { AdapterChatCommand } from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import {
  asBoolean,
  asNumber,
  asString,
  parseJson,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";

// Claude Code caps goal conditions at 4000 characters; reject longer objectives
// up front instead of paying a CLI round-trip for the same rejection.
export const CLAUDE_GOAL_OBJECTIVE_MAX_CHARS = 4000;

// Claude Code clears the active goal for any of these `/goal <arg>` keywords.
// Mirror the full synonym set so the action Paperclip reports always matches
// what the CLI will actually do with the forwarded command line.
const CLAUDE_GOAL_CLEAR_KEYWORDS = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);

export interface ClaudeGoalConfig {
  enabled: boolean;
}

export function readClaudeGoalConfig(config: Record<string, unknown>): ClaudeGoalConfig {
  const goal = parseObject(config.goal);
  return { enabled: asBoolean(goal.enabled, false) };
}

export function listClaudeChatCommands(ctx: { adapterConfig: Record<string, unknown> }): AdapterChatCommand[] {
  if (!readClaudeGoalConfig(ctx.adapterConfig).enabled) return [];
  return [
    {
      name: "goal",
      argHint: "<objective> | status | clear",
      description: "Set, inspect, or clear the Claude Code goal for this issue thread.",
    },
  ];
}

export type ClaudeGoalChatCommandAction = "set" | "status" | "clear";

export function parseClaudeGoalChatCommand(args: string): {
  action: ClaudeGoalChatCommandAction;
  objective: string | null;
  error: string | null;
} {
  const trimmed = args.trim();
  if (!trimmed) {
    return {
      action: "set",
      objective: null,
      error: "`/goal` needs an objective, or use `/goal status` / `/goal clear`.",
    };
  }
  const lower = trimmed.toLowerCase();
  if (lower === "status") return { action: "status", objective: null, error: null };
  if (CLAUDE_GOAL_CLEAR_KEYWORDS.has(lower)) return { action: "clear", objective: null, error: null };
  if (trimmed.length > CLAUDE_GOAL_OBJECTIVE_MAX_CHARS) {
    return {
      action: "set",
      objective: null,
      error: `Goal objectives are limited to ${CLAUDE_GOAL_OBJECTIVE_MAX_CHARS} characters (got ${trimmed.length}).`,
    };
  }
  return { action: "set", objective: trimmed, error: null };
}

/**
 * Structured view of the Claude CLI's zero-turn `/goal` replies. The CLI has a
 * fixed reply grammar for goal commands ("No goal set", "Goal active: …",
 * "Goal cleared: …", plus rejection strings for oversized conditions and
 * untrusted/hooks-disabled contexts); anything outside that grammar means the
 * text was not dispatched as a goal command (e.g. a gated/older CLI sent it to
 * the model instead).
 */
export type ClaudeGoalCliReply =
  | { kind: "none" }
  | { kind: "active"; objective: string; evaluation: string | null }
  | { kind: "cleared"; objective: string }
  | { kind: "set"; objective: string }
  | { kind: "rejected"; message: string };

export function parseClaudeGoalCliReply(text: string): ClaudeGoalCliReply | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^No goal set\b/.test(trimmed)) return { kind: "none" };
  if (
    /^Goal condition is limited to /.test(trimmed) ||
    /^\/goal is only available in trusted workspaces/.test(trimmed) ||
    /^\/goal can't run while hooks are disabled/.test(trimmed)
  ) {
    return { kind: "rejected", message: trimmed };
  }
  const cleared = trimmed.match(/^Goal cleared:\s*([\s\S]+)$/);
  if (cleared) return { kind: "cleared", objective: cleared[1]!.trim() };
  const set = trimmed.match(/^Goal set:\s*([\s\S]+)$/);
  if (set) return { kind: "set", objective: set[1]!.trim() };
  const active = trimmed.match(/^Goal active:\s*([\s\S]+)$/);
  if (active) {
    // Format is `Goal active: <condition> (<evaluation>)` with an optional
    // trailing reason; conditions can themselves contain parentheses, so peel
    // the last parenthesized group as the evaluation on a best-effort basis.
    const detail = active[1]!.trim();
    const evaluation = detail.match(/^([\s\S]*\S)\s*\(([^()]*)\)$/);
    if (evaluation) {
      return { kind: "active", objective: evaluation[1]!.trim(), evaluation: evaluation[2]!.trim() || null };
    }
    return { kind: "active", objective: detail, evaluation: null };
  }
  return null;
}

/**
 * Goal state snapshot reported back through `resultJson.claudeGoal`. Shape and
 * status vocabulary intentionally match the Codex `codexGoal` snapshot so the
 * server-side goal reply card renders both without adapter-specific branches.
 * Claude goals have no token budget, so `tokenBudget` is always null.
 */
export interface ClaudeGoalSnapshot {
  objective: string | null;
  status: "active" | "complete" | "cleared";
  tokenBudget: null;
  tokensUsed: number;
  evaluation?: string | null;
}

const goalCommandSupportCache = new Map<string, Promise<boolean | null>>();

function cacheKeyForTarget(command: string, target: AdapterExecutionTarget | null | undefined): string {
  if (!target) return `local::${command}`;
  if (target.kind === "local") {
    return `local:${target.environmentId ?? ""}:${target.leaseId ?? ""}:${command}`;
  }
  if (target.transport === "sandbox") {
    return ["sandbox", target.providerKey ?? "", target.environmentId ?? "", command].join(":");
  }
  return [
    "ssh",
    target.environmentId ?? "",
    target.leaseId ?? "",
    target.spec.host,
    target.spec.port ?? "",
    target.spec.username ?? "",
    command,
  ].join(":");
}

async function probeClaudeCommandSupportsGoal(input: {
  runId: string;
  command: string;
  target: AdapterExecutionTarget | null | undefined;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  model?: string | null;
}): Promise<boolean | null> {
  // `/goal` with no argument is a zero-turn status query on a supported CLI.
  // On a gated or older CLI the text falls through to the model, so the probe
  // runs in a throwaway session with no tools and a one-turn cap to bound the
  // damage, and never touches the issue session.
  const args = [
    "--print",
    "/goal",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--max-turns",
    "1",
    "--tools",
    "",
    ...(input.model ? ["--model", input.model] : []),
  ];
  const proc = await runAdapterExecutionTargetProcess(input.runId, input.target, input.command, args, {
    cwd: input.cwd,
    env: input.env,
    timeoutSec: Math.max(1, Math.min(input.timeoutSec, 60)),
    graceSec: Math.max(1, Math.min(input.graceSec, 5)),
    onLog: async () => {},
  });
  if (proc.timedOut) return null;
  const parsed = parseJson(proc.stdout);
  if (!parsed) return (proc.exitCode ?? 0) === 0 ? false : null;
  if (asNumber(parsed.num_turns, 0) > 0) return false;
  const reply = parseClaudeGoalCliReply(asString(parsed.result, ""));
  return reply !== null && (reply.kind === "none" || reply.kind === "active");
}

/**
 * Whether the Claude CLI on this execution target dispatches `/goal`
 * non-interactively. The command is feature-gated per install, so this cannot
 * be derived from `--version`/`--help`; definitive probe results are cached
 * per command+target, inconclusive probes are retried on the next call.
 */
export async function claudeCommandSupportsGoalCommand(input: {
  runId: string;
  command: string;
  target: AdapterExecutionTarget | null | undefined;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  model?: string | null;
}): Promise<boolean | null> {
  const key = cacheKeyForTarget(input.command, input.target);
  const cached = goalCommandSupportCache.get(key);
  if (cached) return cached;
  const probe = probeClaudeCommandSupportsGoal(input)
    .then((result) => {
      if (result === null) goalCommandSupportCache.delete(key);
      return result;
    })
    .catch(() => {
      goalCommandSupportCache.delete(key);
      return null;
    });
  goalCommandSupportCache.set(key, probe);
  return probe;
}

export function resetClaudeGoalCommandSupportCacheForTests() {
  goalCommandSupportCache.clear();
}
