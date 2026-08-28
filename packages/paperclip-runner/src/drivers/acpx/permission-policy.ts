import type { NativeAcpxPermissionMode } from "../../contracts/native-execution.js";
import type { QualifiedAcpxAgent } from "./qualified-profiles.js";

const READ_ONLY_PERMISSION_KINDS = new Set(["read", "search", "list"]);
const DEFAULT_RUNNER_OWNED_MCP_SERVERS = new Set(["paperclip"]);
const RUNNER_SEMANTIC_TOOL_PREFIXES = [
  "mcp__paperclip__",
  "mcp.paperclip.",
] as const;

export interface AcpxPermissionRequestLike {
  inferredKind?: unknown;
  raw?: unknown;
}

export type AcpxPermissionDisposition =
  "allow_once" | "reject_once" | "delegate";

export interface AcpxPermissionPolicyOptions {
  runnerOwnedMcpServerNames?: ReadonlySet<string>;
  allConfiguredMcpServersAreRunnerOwned?: boolean;
}

export interface AcpxRuntimePermissionPolicy {
  autoApprove?: readonly string[];
  escalate?: readonly string[];
  defaultAction: "approve" | "deny" | "escalate";
}

export function acpxRuntimePermissionPolicy(
  mode: NativeAcpxPermissionMode,
): AcpxRuntimePermissionPolicy {
  if (mode === "approve-all") return { defaultAction: "approve" };
  if (mode === "deny-all") return { defaultAction: "deny" };
  return {
    autoApprove: ["read", "search", "list"],
    escalate: ["execute", "write", "edit", "delete", "move"],
    defaultAction: "escalate",
  };
}

/**
 * Decide the local part of an ACP permission request. `delegate` means the
 * caller must ask the coordinator and fail closed when no delegate exists.
 */
export function decideAcpxPermission(
  agent: QualifiedAcpxAgent,
  mode: NativeAcpxPermissionMode,
  request: AcpxPermissionRequestLike,
  options: AcpxPermissionPolicyOptions = {},
): AcpxPermissionDisposition {
  if (shouldAutoApproveRunnerOwnedSemanticPermission(agent, request, options))
    return "allow_once";
  if (mode === "approve-all") return "allow_once";
  if (mode === "deny-all") return "reject_once";
  const kind = text(request.inferredKind).toLowerCase();
  return READ_ONLY_PERMISSION_KINDS.has(kind) ? "allow_once" : "delegate";
}

/**
 * Runner-owned semantic operations were already authorized by the run-scoped
 * catalog. This predicate recognizes transport metadata for those operations;
 * display titles never grant authority.
 */
export function shouldAutoApproveRunnerOwnedSemanticPermission(
  agent: QualifiedAcpxAgent,
  request: AcpxPermissionRequestLike,
  options: AcpxPermissionPolicyOptions = {},
): boolean {
  if (agent === "pi") return false;
  const raw = record(request.raw);
  const requestMeta = record(raw._meta);
  const isMcpToolApproval = requestMeta.is_mcp_tool_approval === true;
  if (
    agent === "codex" &&
    isMcpToolApproval &&
    options.allConfiguredMcpServersAreRunnerOwned === true
  ) {
    return true;
  }

  const toolCall = record(raw.toolCall);
  const rawInput = record(toolCall.rawInput);
  const serverName = text(rawInput.serverName);
  const runnerOwnedMcpServers =
    options.runnerOwnedMcpServerNames ?? DEFAULT_RUNNER_OWNED_MCP_SERVERS;
  if (serverName && runnerOwnedMcpServers.has(serverName)) return true;

  const claudeCode = record(record(toolCall._meta).claudeCode);
  return [toolCall.name, claudeCode.toolName].some(isRunnerSemanticToolName);
}

function isRunnerSemanticToolName(value: unknown): boolean {
  const name = text(value);
  return RUNNER_SEMANTIC_TOOL_PREFIXES.some((prefix) =>
    name.startsWith(prefix),
  );
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
