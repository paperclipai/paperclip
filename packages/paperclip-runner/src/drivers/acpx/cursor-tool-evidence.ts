import { updateSingleReadEvidence, type SingleReadEvidence } from "./single-read-evidence.js";
import { createHash } from "node:crypto";
import { redactPaperclipSemanticValue } from "../../semantic-tools/redaction.js";
import type { CanonicalProviderEvent } from "../../provider-events.js";

const rec = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(v);
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
type Fields = Record<string, string | boolean>;
type Tool = { kind?: string; commandSha256?: string; read?: SingleReadEvidence };
type Permission = { requestId: string; kind?: string; hasInput: boolean; commandSha256?: string; declineOffered: boolean; requested?: boolean; outcome?: string; delivered?: boolean };

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
    if (++sequence > 2048 && stage !== "evidence_incomplete") throw new Error("Evidence bound exceeded");
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
    try { return action(); } catch {
      broken = true;
      // Reporting failures cannot rewrite a response already delivered to ACP.
      try { notice("evidence_incomplete", "unavailable", { reason: "projection_failed" }); } catch { /* Sink unavailable. */ }
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
    if (permission.kind !== undefined && permission.kind !== state.kind) throw new Error("Conflicting permission kind");
    // Other native tools have non-command input (for example path/content).
    // Their bounded identity/status evidence must not disable later shell proof.
    if (state.kind === "execute" && permission.hasInput && (!permission.commandSha256 || permission.commandSha256 !== state.commandSha256)) throw new Error("Conflicting permission input");
    const fields: Fields = { requestId: permission.requestId, declineOffered: permission.declineOffered };
    if (state.kind === "execute" || state.kind === "read") fields.operation = state.kind;
    if (state.commandSha256) fields.commandSha256 = state.commandSha256;
    if (!permission.requested) { notice("permission_requested", toolId, fields, "session/request_permission"); permission.requested = true; }
    if (permission.outcome && !permission.delivered) { notice("permission_delivered", toolId, { ...fields, outcome: permission.outcome }, "session/request_permission"); permission.delivered = true; }
  }
  return {
    tool(event: unknown) { safely(() => {
      if (!binding.active()) return;
      const call = rec(event); if (call.type !== "tool_call" || !id(call.toolCallId)) return;
      const toolId = call.toolCallId; let state = tools.get(toolId);
      if (!state) {
        if (call.tag !== "tool_call") return;
        if (tools.size >= 256) throw new Error("Tool bound exceeded");
        state = {}; tools.set(toolId, state);
        if (call.kind === "execute" && !command(call)) throw new Error("Missing command origin");
      } else if (call.tag === "tool_call") throw new Error("Reused tool origin");
      if (call.kind !== undefined && (!id(call.kind) || call.kind.length > 64)) throw new Error("Invalid tool kind");
      if (typeof call.kind === "string") {
        if (state.kind && state.kind !== call.kind) throw new Error("Changed tool kind");
        state.kind = call.kind;
      }
      if (state.kind === "read") state.read = updateSingleReadEvidence(state.read, call, binding.workingDirectory);
      if (call.rawInput !== undefined && state.kind === "execute") {
        const hash = command(call);
        if (!hash || (call.tag !== "tool_call" && !state.commandSha256) || (state.commandSha256 && state.commandSha256 !== hash)) throw new Error("Changed or missing command");
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
        if (raw.sessionId !== binding.sessionId || !id(call.toolCallId) || !id(requestId)) throw new Error("Unbound permission");
        const toolId = call.toolCallId;
        if (permissions.has(toolId) || permissions.size >= 256) throw new Error("Ambiguous permission");
        if (call.kind !== undefined && (!id(call.kind) || call.kind.length > 64)) throw new Error("Invalid permission kind");
        const state: Permission = { requestId, kind: call.kind as string | undefined, hasInput: call.rawInput !== undefined, commandSha256: command(call), declineOffered: offeredActions.includes("decline") };
        permissions.set(toolId, state); flush(toolId);
        return (outcome: string) => { safely(() => {
          if (state.outcome) return;
          if (!["allow_once", "allow_always", "reject_once", "cancel"].includes(outcome)) throw new Error("Unknown outcome");
          state.outcome = outcome; flush(toolId);
        }); };
      });
    },
  };
}
export type CursorToolEvidence = ReturnType<typeof createCursorToolEvidence>;
