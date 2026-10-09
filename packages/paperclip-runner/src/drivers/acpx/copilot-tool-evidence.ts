import { parseSemanticToolReceipt, readNativeSemanticReceipt, sameSemanticReceipt, semanticInputSha256, type SemanticToolReceipt } from "../semantic-tool-receipt.js";
import { updateSingleReadEvidence, type SingleReadEvidence } from "./single-read-evidence.js";
import { createHash } from "node:crypto";
import { redactPaperclipSemanticValue } from "../../semantic-tools/redaction.js";
import type { CanonicalProviderEvent } from "../../provider-events.js";
import { safeCopilotEditTarget } from "./copilot-permission-context.js";

const LIMIT = 256;
const CATEGORY = "copilot_tool_evidence_v1";
type Fields = Record<string, string | number | boolean | null>;
interface Tool { kind?: string; input?: string; fields: Fields; invalid?: boolean; semanticInput?: string; semanticReceipt?: SemanticToolReceipt; read?: SingleReadEvidence }
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const identity = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(v);
const shellIdentity = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_.-]{1,80}$/u.test(v);
const digest = (v: string) => createHash("sha256").update(v).digest("hex");

/**
 * Observation only, bound to one active ACP prompt iterator and its permission
 * callbacks. Session passthrough notifications cannot enter this projector.
 * Old sessions without these notices supply no qualification evidence. This
 * additive projection changes source/pack provenance, not execution identity.
 */
export function createCopilotToolEvidence(binding: {
  sessionId: string; turnId: string; workingDirectory: string;
  active: () => boolean; emit: (event: CanonicalProviderEvent) => void;
  unavailable?: () => void;
}) {
  const tools = new Map<string, Tool>();
  const shells = new Map<string, string | null>();
  const permissionTools = new Set<string>();
  const semanticReceipts = new Map<string, SemanticToolReceipt | null>();
  const matchedReceipts = new Map<string, string>();
  let sequence = 0;
  let incomplete = false;
  let broken = false;
  function safely<T>(action: () => T): T | undefined {
    if (broken) return;
    try { return action(); } catch {
      // Observation cannot undo an authoritative response or terminal outcome.
      broken = true;
      try { notice("evidence_incomplete", "unavailable", { reason: "projection_failed" }); } catch { /* Report through diagnostics if the sink itself failed. */ }
      try { binding.unavailable?.(); } catch { /* Diagnostics cannot undo delivery. */ }
      return;
    }
  }
  function notice(stage: string, toolCallId: string | undefined, fields: Fields, method = "session/update", category = CATEGORY) {
    if (!binding.active() || !identity(binding.sessionId) || !identity(binding.turnId)) return;
    if (sequence >= 2048) {
      if (incomplete) return;
      incomplete = true; stage = "evidence_incomplete"; fields = { reason: "notice_limit" };
    }
    const itemId = `copilot-evidence-${digest(`${binding.sessionId}:${binding.turnId}`).slice(0, 24)}-${++sequence}`;
    binding.emit({ eventType: "provider.notice.recorded", itemId, payload: redactPaperclipSemanticValue({
      schema: "paperclip.provider.notice.v1", noticeId: itemId, severity: "info",
      category, scope: "turn", recoverable: true, userActionable: false,
      summary: stage === "semantic_result" ? "Paperclip returned a semantic tool result." : stage === "evidence_incomplete" ? "Some Copilot activity details are unavailable."
        : stage === "permission_requested" ? "Copilot requested permission."
        : stage === "permission_delivered" ? (fields.outcome === "reject_once" ? "Copilot received your denial." : "Copilot received your permission decision.")
        : fields.shellState === "started" ? (fields.detach === false ? "Copilot started an attached command." : "Copilot started a background command.")
        : fields.shellState === "completed" ? `Copilot reported command completion with exit code ${fields.exitCode}.`
        : fields.operation === "edit" ? `Copilot file operation: ${fields.status}.`
        : `Copilot tool operation: ${fields.status}.`,
      provenance: { method, eventType: stage, sessionId: binding.sessionId, turnId: binding.turnId },
      details: Object.entries({ stage, ...(toolCallId === undefined ? {} : { toolCallId }), ...fields }).map(([name, value]) => ({ name, value: String(value) })),
    }) as Record<string, unknown> });
  }
  function inputFields(call: Record<string, unknown>): Fields {
    const input = record(call.rawInput);
    const fields: Fields = {};
    if (call.kind === "edit") { const path = safeCopilotEditTarget(call, binding.workingDirectory); if (path) fields.target = path; }
    if (call.kind === "execute" && typeof input.command === "string" && input.command.length > 0 && Buffer.byteLength(input.command) <= 64 * 1024) {
      // ACP exposes an execution kind, not the native tool name. Never infer
      // `bash` from a provider-controlled title/description.
      fields.operation = "execute";
      fields.commandSha256 = `sha256:${digest(input.command)}`;
      if (input.mode === "sync" || input.mode === "async") fields.mode = input.mode;
      if (typeof input.detach === "boolean") fields.detach = input.detach;
    }
    if (shellIdentity(input.shellId)) fields.shellId = input.shellId;
    return fields;
  }
  const projection = {
    tool(event: unknown) {
      if (!binding.active()) return;
      const call = record(event);
      if (call.type !== "tool_call" || !identity(call.toolCallId)) return;
      const id = call.toolCallId;
      let state = tools.get(id);
      if (!state) {
        // A delta without its origin cannot acquire a different tool's fields.
        if (call.tag !== "tool_call") return;
        if (tools.size >= LIMIT) {
          if (!incomplete) { incomplete = true; notice("evidence_incomplete", id, { reason: "tool_limit" }); }
          return;
        }
        state = { fields: {} }; tools.set(id, state);
      } else if (call.tag === "tool_call") { state.invalid = true; notice("evidence_incomplete", id, { reason: "reused_tool_origin" }); }
      if (state.invalid) return;
      if (state.semanticReceipt) { state.invalid = true; notice("evidence_incomplete", id, { reason: "reused_semantic_lifecycle" }); return; }
      if (typeof call.kind === "string") {
        if (state.kind && state.kind !== call.kind) { state.invalid = true; notice("evidence_incomplete", id, { reason: "changed_tool_kind" }); return; }
        state.kind = call.kind;
      }
      if (state.kind === "read") state.read = updateSingleReadEvidence(state.read, call, binding.workingDirectory);
      if (call.rawInput !== undefined) {
        // Retain only a bounded digest of the native arguments, never their text.
        let inputDigest: string | undefined;
        try { if (Buffer.byteLength(JSON.stringify(call.rawInput)) <= 1024 * 1024) inputDigest = semanticInputSha256(call.rawInput); } catch { /* Malformed input cannot correlate. */ }
        if (state.semanticInput && inputDigest !== state.semanticInput) { state.invalid = true; notice("evidence_incomplete", id, { reason: "changed_tool_input" }); return; }
        state.semanticInput = inputDigest;
        const fields = inputFields({ ...call, kind: state.kind });
        const fingerprint = JSON.stringify(fields);
        if (state.input && state.input !== fingerprint) { state.invalid = true; notice("evidence_incomplete", id, { reason: "changed_tool_input" }); return; }
        state.input = fingerprint; state.fields = fields;
      }
      const status = ["pending", "in_progress", "completed", "failed"].includes(String(call.status)) ? String(call.status) : undefined;
      if (!status) return;
      const fields: Fields = { ...state.fields, status, ...(state.read?.targetSha256 ? { readTargetSha256: state.read.targetSha256 } : {}) };
      if (state.kind === "edit" || state.kind === "read") fields.operation = state.kind;
      const output = record(call.rawOutput).content;
      // Parse only the pinned native wrapper, never substrings in command output.
      if (status === "completed" && typeof output === "string" && output.length <= 256) {
        const started = /^<command started in background with shellId: ([A-Za-z0-9_.-]{1,80})>$/u.exec(output.trim());
        if (started && typeof fields.commandSha256 === "string") {
          const shellId = started[1]!;
          if (!shells.has(shellId) && shells.size < LIMIT) shells.set(shellId, id);
          else if (shells.get(shellId) !== id) { shells.set(shellId, null); notice("evidence_incomplete", id, { reason: "reused_shell_origin" }); }
          if (shells.get(shellId) === id) { fields.shellId = shellId; fields.commandToolCallId = id; fields.shellState = "started"; }
        }
        const completed = /^<shellId: ([A-Za-z0-9_.-]{1,80}) completed with exit code (-?\d{1,10})>$/u.exec(output.trim());
        if (completed && state.kind === "read" && fields.shellId === completed[1] && shells.get(completed[1]!) && !tools.get(shells.get(completed[1]!)!)?.invalid) {
          const exitCode = Number(completed[2]);
          if (Number.isSafeInteger(exitCode) && exitCode >= -2147483648 && exitCode <= 2147483647) {
            fields.commandToolCallId = shells.get(completed[1]!)!;
            fields.shellState = "completed"; fields.exitCode = exitCode;
          }
        }
      }
      if (call.rawOutput !== undefined) {
        const candidate = readNativeSemanticReceipt(call.rawOutput);
        if (candidate) {
          const authoritative = semanticReceipts.get(candidate.callIdentitySha256);
          const previous = matchedReceipts.get(candidate.callIdentitySha256);
          if ((status !== "completed" && status !== "failed") || !authoritative
            || !sameSemanticReceipt(authoritative, candidate) || state.semanticInput !== candidate.inputSha256
            || (status === "failed") !== (candidate.outcome === "error") || previous !== undefined) {
            state.invalid = true;
            notice("evidence_incomplete", id, { reason: "semantic_receipt_conflict" });
            return;
          }
          matchedReceipts.set(candidate.callIdentitySha256, id);
          state.semanticReceipt = candidate;
          fields.semanticOperationId = candidate.operationId;
          fields.semanticCallIdentitySha256 = candidate.callIdentitySha256;
          fields.semanticInputSha256 = candidate.inputSha256;
          if (candidate.schema === "paperclip.semantic_tool_receipt.v2") fields.semanticNormalizedInputSha256 = candidate.normalizedInputSha256;
          fields.semanticResultSha256 = candidate.resultSha256;
          fields.semanticOutcome = candidate.outcome;
        }
      }
      notice("tool", id, fields);
    },
    permission(request: unknown, requestId: string, offeredActions: readonly string[]) {
      const raw = record(record(request).raw);
      const call = record(raw.toolCall);
      if (!binding.active() || raw.sessionId !== binding.sessionId || !identity(call.toolCallId) || !identity(requestId)) return undefined;
      if (permissionTools.has(call.toolCallId) || permissionTools.size >= LIMIT) { notice("evidence_incomplete", call.toolCallId, { reason: "ambiguous_permission_origin" }); return undefined; }
      permissionTools.add(call.toolCallId);
      const fields: Fields = { requestId, ...inputFields(call) };
      if (call.kind === "edit" || call.kind === "read") fields.operation = call.kind;
      fields.declineOffered = offeredActions.includes("decline");
      notice("permission_requested", call.toolCallId, fields, "session/request_permission");
      let delivered = false;
      return (outcome: string) => safely(() => {
        if (delivered || !["allow_once", "allow_always", "reject_once", "cancel"].includes(outcome)) return;
        delivered = true;
        notice("permission_delivered", call.toolCallId as string, { ...fields, outcome }, "session/request_permission");
      });
    },
  };
  return {
    captureSemanticReceipt(): ((receipt: SemanticToolReceipt) => void) | undefined {
      if (!binding.active()) return undefined;
      // This closure belongs to this turn, even if a successor becomes active.
      return receipt => { safely(() => {
        if (!binding.active()) return;
        const parsed = parseSemanticToolReceipt(receipt);
        if (!parsed || semanticReceipts.size >= LIMIT || semanticReceipts.has(parsed.callIdentitySha256)) {
          if (parsed && semanticReceipts.has(parsed.callIdentitySha256)) semanticReceipts.set(parsed.callIdentitySha256, null);
          notice("evidence_incomplete", "semantic", { reason: "ambiguous_semantic_receipt" });
          return;
        }
        semanticReceipts.set(parsed.callIdentitySha256, parsed);
        notice("semantic_result", undefined, { ...parsed }, "paperclip/semantic_tool_result", parsed.schema === "paperclip.semantic_tool_receipt.v2" ? "paperclip_semantic_tool_receipt_v2" : "paperclip_semantic_tool_receipt_v1");
      }); };
    },
    tool: (event: unknown) => { safely(() => projection.tool(event)); },
    permission: (request: unknown, requestId: string, offeredActions: readonly string[]) => safely(() => projection.permission(request, requestId, offeredActions)),
  };
}
export type CopilotToolEvidence = ReturnType<typeof createCopilotToolEvidence>;
