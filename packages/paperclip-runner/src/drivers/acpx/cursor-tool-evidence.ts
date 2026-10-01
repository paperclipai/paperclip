import { updateSingleReadEvidence, type SingleReadEvidence } from "./single-read-evidence.js";
import { createHash } from "node:crypto";
import { redactPaperclipSemanticValue } from "../../semantic-tools/redaction.js";
import type { CanonicalProviderEvent } from "../../provider-events.js";
import { cursorToolIdentity } from "./cursor-plan-tool-identity.js";

const rec = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(v);
// ACP tool identities are opaque provider strings. Apply the existing bounded
// tool identity transform rather than rejecting IDs accepted by the ACP SDK.
const nativeToolId = (v: unknown): string | undefined => typeof v === "string" && v.length > 0 && v.length <= 240 ? cursorToolIdentity(v) : undefined;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
type Fields = Record<string, string | boolean>;
type Tool = { kind?: string; commandSha256?: string; read?: SingleReadEvidence };
type Permission = { requestId: string; kind?: string; hasInput: boolean; commandSha256?: string; declineOffered: boolean; requested?: boolean; outcome?: string; delivered?: boolean };
type ProjectionFailureReason =
  | "evidence_limit" | "tool_limit" | "missing_command_origin" | "reused_tool_origin"
  | "invalid_tool_kind" | "changed_tool_kind" | "changed_or_missing_command"
  | "conflicting_permission_kind" | "conflicting_permission_input"
  | "permission_session_mismatch" | "invalid_permission_tool_identity" | "invalid_request_identity"
  | "ambiguous_permission" | "invalid_permission_kind" | "unknown_outcome";
// Only locally constructed failures may publish a reason. Provider or sink
// exception messages, causes, and similarly named fields are never evidence.
class ProjectionFailure extends Error {
  constructor(readonly reason: ProjectionFailureReason) { super(reason); }
}

/** Passive, bounded evidence from the active prompt iterator only. Cursor's
 * permission frame omits rawInput; only the same tool's original tool_call may
 * supply its command. Never infer a command from a title or a terminal delta. */
export function createCursorToolEvidence(binding: {
  sessionId: string; turnId: string; workingDirectory: string; active(): boolean;
  emit(event: CanonicalProviderEvent): void; unavailable?(): void;
}) {
  const tools = new Map<string, Tool>(); const permissions = new Map<string, Permission>();
  let sequence = 0; let broken = false;
  function notice(stage: string, toolCallId: string, fields: Fields, method = "session/update") {
    if (!binding.active() || !id(binding.sessionId) || !id(binding.turnId)) return;
    if (++sequence > 2048 && stage !== "evidence_incomplete") throw new ProjectionFailure("evidence_limit");
    const itemId = `cursor-evidence-${digest(`${binding.sessionId}:${binding.turnId}`).slice(0, 24)}-${sequence}`;
    binding.emit({ eventType: "provider.notice.recorded", itemId, payload: redactPaperclipSemanticValue({
      schema: "paperclip.provider.notice.v1", noticeId: itemId, severity: "info", category: "cursor_tool_evidence_v1", scope: "turn", recoverable: true, userActionable: false,
      summary: stage === "evidence_incomplete" ? "Some Cursor activity details are unavailable." : stage === "permission_delivered" ? "Cursor received your permission decision." : "Cursor native tool activity recorded.",
      provenance: { method, eventType: stage, sessionId: binding.sessionId, turnId: binding.turnId },
      details: Object.entries({ stage, toolCallId, ...fields }).map(([name, value]) => ({ name, value: String(value) })),
    }) as Record<string, unknown> });
  }
  function safely<T>(action: () => T): T | undefined {
    if (broken) return;
    try { return action(); } catch (error) {
      broken = true;
      // Reporting failures cannot rewrite a response already delivered to ACP.
      const reason = error instanceof ProjectionFailure ? error.reason : "projection_failed";
      try { notice("evidence_incomplete", "unavailable", { reason }); } catch { /* Sink unavailable. */ }
      try { binding.unavailable?.(); } catch { /* Diagnostics remain passive. */ }
    }
  }
  function command(call: Record<string, unknown>): string | undefined {
    const value = rec(call.rawInput).command;
    if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value) > 64 * 1024) return;
    return `sha256:${digest(value)}`;
  }
  function flush(toolId: string) {
    const state = tools.get(toolId), permission = permissions.get(toolId);
    if (!state || !permission) return;
    if (permission.kind !== undefined && permission.kind !== state.kind) throw new ProjectionFailure("conflicting_permission_kind");
    // Other native tools have non-command input (for example path/content).
    // Their bounded identity/status evidence must not disable later shell proof.
    if (state.kind === "execute" && permission.hasInput && (!permission.commandSha256 || permission.commandSha256 !== state.commandSha256)) throw new ProjectionFailure("conflicting_permission_input");
    const fields: Fields = { requestId: permission.requestId, declineOffered: permission.declineOffered };
    if (state.kind === "execute" || state.kind === "read") fields.operation = state.kind;
    if (state.commandSha256) fields.commandSha256 = state.commandSha256;
    if (!permission.requested) { notice("permission_requested", toolId, fields, "session/request_permission"); permission.requested = true; }
    if (permission.outcome && !permission.delivered) { notice("permission_delivered", toolId, { ...fields, outcome: permission.outcome }, "session/request_permission"); permission.delivered = true; }
  }
  return {
    tool(event: unknown) { safely(() => {
      if (!binding.active()) return;
      const call = rec(event); if (call.type !== "tool_call") return;
      const toolId = nativeToolId(call.toolCallId); if (toolId === undefined) return;
      let state = tools.get(toolId);
      if (!state) {
        if (call.tag !== "tool_call") return;
        if (tools.size >= 256) throw new ProjectionFailure("tool_limit");
        state = {}; tools.set(toolId, state);
        if (call.kind === "execute" && !command(call)) throw new ProjectionFailure("missing_command_origin");
      } else if (call.tag === "tool_call") throw new ProjectionFailure("reused_tool_origin");
      if (call.kind !== undefined && (!id(call.kind) || call.kind.length > 64)) throw new ProjectionFailure("invalid_tool_kind");
      if (typeof call.kind === "string") {
        if (state.kind && state.kind !== call.kind) throw new ProjectionFailure("changed_tool_kind");
        state.kind = call.kind;
      }
      if (state.kind === "read") state.read = updateSingleReadEvidence(state.read, call, binding.workingDirectory);
      if (call.rawInput !== undefined && state.kind === "execute") {
        const hash = command(call);
        if (!hash || (call.tag !== "tool_call" && !state.commandSha256) || (state.commandSha256 && state.commandSha256 !== hash)) throw new ProjectionFailure("changed_or_missing_command");
        state.commandSha256 = hash;
      }
      if (!["pending", "in_progress", "completed", "failed"].includes(String(call.status))) return;
      // Publish queued permission delivery before its terminal tool result.
      if (call.tag !== "tool_call") flush(toolId);
      notice("tool", toolId, { status: String(call.status), ...(["execute", "read"].includes(state.kind ?? "") ? { operation: state.kind! } : {}), ...(state.commandSha256 ? { commandSha256: state.commandSha256 } : {}), ...(state.read?.targetSha256 ? { readTargetSha256: state.read.targetSha256 } : {}) });
      flush(toolId);
    }); },
    permission(request: unknown, requestId: string, offeredActions: readonly string[]) {
      return safely(() => {
        if (!binding.active()) return;
        const raw = rec(rec(request).raw), call = rec(raw.toolCall);
        if (raw.sessionId !== binding.sessionId) throw new ProjectionFailure("permission_session_mismatch");
        const toolId = nativeToolId(call.toolCallId);
        if (toolId === undefined) throw new ProjectionFailure("invalid_permission_tool_identity");
        if (!id(requestId)) throw new ProjectionFailure("invalid_request_identity");
        if (permissions.has(toolId) || permissions.size >= 256) throw new ProjectionFailure("ambiguous_permission");
        if (call.kind !== undefined && (!id(call.kind) || call.kind.length > 64)) throw new ProjectionFailure("invalid_permission_kind");
        const state: Permission = { requestId, kind: call.kind as string | undefined, hasInput: call.rawInput !== undefined, commandSha256: command(call), declineOffered: offeredActions.includes("decline") };
        permissions.set(toolId, state); flush(toolId);
        return (outcome: string) => { safely(() => {
          if (state.outcome) return;
          if (!["allow_once", "allow_always", "reject_once", "cancel"].includes(outcome)) throw new ProjectionFailure("unknown_outcome");
          state.outcome = outcome; flush(toolId);
        }); };
      });
    },
  };
}
export type CursorToolEvidence = ReturnType<typeof createCursorToolEvidence>;
