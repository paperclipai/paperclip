/**
 * Canonical payloads for governance activity: harness hooks and automatic
 * approval reviews. These are display records that make decisions nobody
 * clicked auditable; they carry no execution authority.
 *
 * Payload shapes are the `hook` and `safetyReview` definitions in
 * protocol/schemas/provider-event.schema.json.
 */

import { createHash } from "node:crypto";

const MESSAGE_LIMIT = 4000;
const ACTION_LIMIT = 1000;
const NAME_LIMIT = 160;

export type HookOutcome = "running" | "passed" | "context" | "feedback" | "blocked" | "stopped" | "failed";
type HookStatus = "running" | "completed" | "failed" | "cancelled" | "blocked" | "stopped";
type SafetyDecision = "pending" | "allowed" | "denied" | "user_required" | "timed_out" | "aborted" | "unknown";

const SAFETY_ACTION_KINDS = new Set([
  "command",
  "execve",
  "writeStdin",
  "applyPatch",
  "networkAccess",
  "mcpToolCall",
  "requestPermissions",
]);
const RISK_LEVELS = new Set(["low", "medium", "high", "critical"]);
const USER_AUTHORIZATION = new Set(["unknown", "low", "medium", "high"]);

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function clip(value: string, limit: number): string {
  const characters = [...value];
  return characters.length <= limit ? value : `${characters.slice(0, limit - 1).join("")}…`;
}

function nullableClip(value: unknown, limit: number): string | null {
  const trimmed = text(value).trim();
  return trimmed ? clip(trimmed, limit) : null;
}

function nonNegativeInteger(value: unknown): number | null {
  if (typeof value === "bigint") return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

export function safeGovernanceId(value: string, fallback: string): string {
  const candidate = value.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, NAME_LIMIT);
  return /^[A-Za-z0-9]/.test(candidate) ? candidate : fallback;
}

const HOOK_CONFIG_FILES = new Set(["config.toml", "hooks.json", "requirements.toml", "managed_config.toml"]);

/**
 * Where the hook is defined, without the absolute host path. Codex reports
 * the file that declares the hook, usually `config.toml`, so a config file
 * reads as its layer ("user hooks", "project hooks") rather than a filename.
 */
function hookSource(path: unknown, layer: unknown): string | null {
  const name = text(path).trim().split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  if (name && !HOOK_CONFIG_FILES.has(name)) return clip(name, NAME_LIMIT);
  const source = text(layer);
  if (source === "user" || source === "project" || source === "system" || source === "plugin") return `${source} hooks`;
  if (source && source !== "unknown") return "managed hooks";
  return name ? clip(name, NAME_LIMIT) : null;
}

interface HookEntry {
  kind: string;
  text: string;
}

function hookEntries(value: unknown): HookEntry[] {
  return (Array.isArray(value) ? value : [])
    .slice(0, 64)
    .map((entry) => ({ kind: text(record(entry).kind), text: text(record(entry).text).trim() }))
    .filter((entry) => entry.text);
}

function firstEntry(entries: HookEntry[], kinds: string[]): string | undefined {
  for (const kind of kinds) {
    const match = entries.find((entry) => entry.kind === kind);
    if (match) return match.text;
  }
  return undefined;
}

/**
 * Codex reuses `run.id` (`<event>:<order>:<config path>`) for every call of
 * the same configured hook, and it embeds a host path. Key one invocation by
 * a digest of that id plus its start time, which started and completed share.
 */
function codexHookRunId(run: Record<string, unknown>): string {
  const definition = text(run.id) || `${text(run.eventName)}:${String(run.displayOrder ?? "")}`;
  const digest = createHash("sha256").update(definition).digest("hex").slice(0, 16);
  const startedAt = nonNegativeInteger(run.startedAt);
  return `hook-${digest}${startedAt != null ? `-${startedAt}` : ""}`;
}

/** `/bin/zsh -lc 'rm -rf build'` reads as `rm -rf build`. */
function unwrapShellCommand(command: string): string {
  const match = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh -l?c '((?:[^']|'\\'')*)'$/.exec(command.trim());
  return match ? match[1]!.replaceAll("'\\''", "'") : command;
}

/** Codex `hook/started` and `hook/completed` (HookRunSummary in `params.run`). */
export function codexHookPayload(method: string, runValue: unknown): Record<string, unknown> {
  const run = record(runValue);
  const started = method === "hook/started";
  const rawStatus = started ? "running" : text(run.status) || "completed";
  const entries = hookEntries(run.entries);
  const status: HookStatus =
    rawStatus === "running" || rawStatus === "failed" || rawStatus === "blocked" || rawStatus === "stopped"
      ? rawStatus
      : "completed";
  const outcome: HookOutcome =
    status === "running"
      ? "running"
      : status === "blocked" || status === "stopped" || status === "failed"
        ? status
        : entries.some((entry) => entry.kind === "feedback")
          ? "feedback"
          : entries.some((entry) => entry.kind === "context")
            ? "context"
            : "passed";
  const message =
    outcome === "blocked" || outcome === "stopped"
      ? firstEntry(entries, ["stop", "feedback", "error", "warning", "context"])
      : outcome === "failed"
        ? firstEntry(entries, ["error", "warning", "stop", "feedback"])
        : outcome === "feedback"
          ? firstEntry(entries, ["feedback"])
          : outcome === "context"
            ? firstEntry(entries, ["context"])
            : firstEntry(entries, ["warning"]);
  return {
    schema: "paperclip.hook.v1",
    hookId: codexHookRunId(run),
    event: clip(text(run.eventName) || "unknown", NAME_LIMIT),
    scope: clip(text(run.scope) || "provider", NAME_LIMIT),
    status,
    // Codex reports `sync` hooks, which can block the action, and `async` ones.
    blocking: run.executionMode === "sync" || run.executionMode === "blocking",
    durationMs: nonNegativeInteger(run.durationMs),
    summary: nullableClip(run.statusMessage, MESSAGE_LIMIT),
    outcome,
    message: message ? clip(message, MESSAGE_LIMIT) : nullableClip(run.statusMessage, MESSAGE_LIMIT),
    source: hookSource(run.sourcePath, run.source),
    toolName: null,
  };
}

/** A short, display-safe description of what the reviewer was asked to approve. */
function safetyAction(actionValue: unknown): { kind: string; summary: string | null } {
  const action = record(actionValue);
  const type = text(action.type);
  const kind = SAFETY_ACTION_KINDS.has(type) ? type : "unknown";
  let summary = "";
  switch (type) {
    case "command":
      summary = unwrapShellCommand(text(action.command));
      break;
    case "execve": {
      const argv = Array.isArray(action.argv) ? action.argv.filter((part): part is string => typeof part === "string") : [];
      summary = argv.length > 0 ? argv.join(" ") : text(action.program);
      break;
    }
    case "writeStdin":
      // Never echo the input itself; it can be a password typed into a prompt.
      summary = "input to a running command";
      break;
    case "applyPatch": {
      const files = Array.isArray(action.files) ? action.files.filter((file): file is string => typeof file === "string") : [];
      summary = files.length === 1 ? `edit ${files[0]}` : `edit ${files.length} files${files.length ? `: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}` : ""}`;
      break;
    }
    case "networkAccess": {
      const host = text(action.host);
      const port = nonNegativeInteger(action.port);
      summary = host ? (port != null ? `${host}:${port}` : host) : text(action.target);
      break;
    }
    case "mcpToolCall":
      summary = [text(action.connectorName) || text(action.server), text(action.toolTitle) || text(action.toolName)]
        .filter(Boolean)
        .join(" · ");
      break;
    case "requestPermissions":
      summary = text(action.reason) || "additional permissions";
      break;
  }
  const trimmed = summary.replace(/\s+/g, " ").trim();
  return { kind, summary: trimmed ? clip(trimmed, ACTION_LIMIT) : null };
}

function safetyDecision(started: boolean, status: string): SafetyDecision {
  if (started) return "pending";
  switch (status) {
    case "approved": return "allowed";
    case "denied": return "denied";
    case "timedOut": return "timed_out";
    case "aborted": return "aborted";
    case "inProgress": return "pending";
    default: return "unknown";
  }
}

/** Codex `item/autoApprovalReview/started|completed` (approval auto-review). */
export function codexSafetyReviewPayload(method: string, paramsValue: unknown): Record<string, unknown> {
  const params = record(paramsValue);
  const review = record(params.review);
  const started = method.endsWith("started");
  const decision = safetyDecision(started, text(review.status));
  const action = safetyAction(params.action);
  const riskLevel = text(review.riskLevel);
  const userAuthorization = text(review.userAuthorization);
  const target = text(params.targetItemId);
  return {
    schema: "paperclip.safety.review.v1",
    reviewId: safeGovernanceId(text(params.reviewId), "safety-review"),
    targetExecutionId: target ? safeGovernanceId(target, "execution") : null,
    status: started || decision === "pending" ? "running" : "completed",
    decision,
    summary: nullableClip(review.rationale, MESSAGE_LIMIT),
    actionKind: action.kind,
    action: action.summary,
    riskLevel: RISK_LEVELS.has(riskLevel) ? riskLevel : null,
    userAuthorization: USER_AUTHORIZATION.has(userAuthorization) ? userAuthorization : null,
    rationale: nullableClip(review.rationale, MESSAGE_LIMIT),
    decidedBy: nullableClip(params.decisionSource, NAME_LIMIT),
  };
}

const CLAUDE_FEEDBACK_EVENTS = new Set(["Stop", "SubagentStop", "PostToolUse", "PostToolUseFailure"]);
const CLAUDE_CONTEXT_EVENTS = new Set(["UserPromptSubmit", "SessionStart"]);

function parsedHookJson(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return record(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/**
 * Claude Agent SDK `hook_started` / `hook_response`, forwarded by the patched
 * claude-agent-acp adapter on `session_info_update._meta.claudeCode.hook`.
 * Claude reports the raw process result, so the decision is read the same way
 * Claude Code reads it: exit code 2 blocks, and JSON output can deny a tool,
 * block, stop the session or add context.
 */
export function claudeHookPayload(hookValue: unknown): { started: boolean; payload: Record<string, unknown> } {
  const hook = record(hookValue);
  const started = hook.phase === "started";
  const eventName = text(hook.hookEvent) || text(hook.hookName).split(":")[0] || "unknown";
  const [, matcher] = text(hook.hookName).split(":", 2);
  const toolName = matcher && matcher !== eventName ? clip(matcher, NAME_LIMIT) : null;
  const stdout = text(hook.stdout);
  const stderr = text(hook.stderr).trim();
  // The adapter reads the decision from the complete stdout before it bounds
  // display text; prefer that, since bounded JSON may no longer parse.
  const forwarded = record(hook.decision);
  const json = Object.keys(forwarded).length > 0
    ? {
        continue: forwarded.continue,
        stopReason: forwarded.stopReason,
        decision: forwarded.decision,
        reason: forwarded.reason,
        systemMessage: forwarded.systemMessage,
        hookSpecificOutput: {
          permissionDecision: forwarded.permissionDecision,
          permissionDecisionReason: forwarded.permissionDecisionReason,
          additionalContext: forwarded.additionalContext,
        },
      }
    : parsedHookJson(stdout);
  const specific = record(json?.hookSpecificOutput);
  const exitCode = nonNegativeInteger(hook.exitCode);
  const feedbackEvent = CLAUDE_FEEDBACK_EVENTS.has(eventName);

  let outcome: HookOutcome;
  let message: string | undefined;
  if (started) {
    outcome = "running";
  } else if (hook.outcome === "cancelled") {
    outcome = "failed";
    message = stderr || "The hook was cancelled.";
  } else if (exitCode === 2) {
    outcome = feedbackEvent ? "feedback" : "blocked";
    message = stderr || undefined;
  } else if (hook.outcome === "error") {
    outcome = "failed";
    message = stderr || text(hook.output).trim() || undefined;
  } else if (json && json.continue === false) {
    outcome = "stopped";
    message = text(json.stopReason) || undefined;
  } else if (specific.permissionDecision === "deny") {
    outcome = "blocked";
    message = text(specific.permissionDecisionReason) || text(json?.reason) || undefined;
  } else if (json?.decision === "block") {
    outcome = feedbackEvent ? "feedback" : "blocked";
    message = text(json.reason) || undefined;
  } else if (text(specific.additionalContext).trim()) {
    outcome = "context";
    message = text(specific.additionalContext);
  } else if (!json && stdout.trim() && CLAUDE_CONTEXT_EVENTS.has(eventName)) {
    outcome = "context";
    message = stdout;
  } else {
    outcome = "passed";
    message = text(json?.systemMessage) || undefined;
  }
  const status: HookStatus =
    outcome === "running" ? "running"
      : outcome === "blocked" ? "blocked"
        : outcome === "stopped" ? "stopped"
          : hook.outcome === "cancelled" ? "cancelled"
            : outcome === "failed" ? "failed"
              : "completed";
  const trimmedMessage = message?.trim();
  return {
    started,
    payload: {
      schema: "paperclip.hook.v1",
      hookId: safeGovernanceId(text(hook.hookId), "hook"),
      event: clip(eventName, NAME_LIMIT),
      scope: "turn",
      status,
      // Claude command hooks run synchronously and can block the action.
      blocking: true,
      durationMs: null,
      summary: null,
      outcome,
      message: trimmedMessage ? clip(trimmedMessage, MESSAGE_LIMIT) : null,
      source: null,
      toolName,
    },
  };
}

/**
 * A Claude hook forwarded on an ACPX `session_info_update` status event, as a
 * display-only canonical event. Returns null for every other runtime event.
 */
export function claudeHookCanonicalEvent(
  event: unknown,
): { eventType: "hook.started" | "hook.completed"; payload: Record<string, unknown>; itemId: string } | null {
  const runtime = record(event);
  if (runtime.type !== "status" || runtime.tag !== "session_info_update") return null;
  const hook = record(record(record(runtime._meta).claudeCode).hook);
  if (!text(hook.hookId)) return null;
  const { started, payload } = claudeHookPayload(hook);
  return { eventType: started ? "hook.started" : "hook.completed", payload, itemId: String(payload.hookId) };
}
