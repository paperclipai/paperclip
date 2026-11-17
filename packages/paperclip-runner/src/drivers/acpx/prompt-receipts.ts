import type { QualifiedAcpxAgent } from "./qualified-profiles.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const wireId = (value: unknown): value is string | number =>
  (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(value)) || (Number.isSafeInteger(value) && Number(value) >= 0);

export interface PiPromptReceipt {
  request_id: string;
  receipt: { provenance: "assistant_message_receipts" | "assistant_message_and_compaction_receipts"; cost_usd?: number };
}
export interface CursorPromptReceipt {
  request_id: string;
  receipt: unknown;
}

/** Pi's wrapper attaches cost provenance to the prompt response usage `_meta`. */
export function parsePiPromptReceipt(raw: unknown): PiPromptReceipt["receipt"] | null {
  const receipt = record(raw);
  if (receipt.provenance !== "assistant_message_receipts" && receipt.provenance !== "assistant_message_and_compaction_receipts") return null;
  const cost = receipt.costUsd;
  if (cost !== undefined && !(typeof cost === "number" && Number.isFinite(cost) && cost >= 0)) return null;
  return { provenance: receipt.provenance, ...(cost === undefined ? {} : { cost_usd: cost }) };
}

/**
 * Captures the Pi or Cursor receipt carried on the active turn's own
 * `session/prompt` reply. `onAcpMessage` sees the outbound prompt and its
 * inbound reply, so the receipt is bound to this exact wire request instead
 * of whatever ACPX last saved in its session record. A second prompt, a
 * mismatched session, or conflicting replies invalidate the turn's receipt.
 */
export function createAcpxPromptReceiptCollector(agent: QualifiedAcpxAgent) {
  if (agent !== "pi" && agent !== "cursor") return null;
  let active: { requestId: string; sessionId: string; wireId?: string | number; invalid: boolean; result: RecordValue | null } | null = null;
  return {
    begin(requestId: string, sessionId: string) {
      active = { requestId, sessionId, invalid: false, result: null };
    },
    observe(direction: "inbound" | "outbound", value: unknown) {
      if (!active || active.invalid) return;
      const message = record(value);
      if (direction === "outbound") {
        if (message.method !== "session/prompt" || record(message.params).sessionId !== active.sessionId) return;
        if (active.wireId !== undefined || !wireId(message.id)) { active.invalid = true; return; }
        active.wireId = message.id;
        return;
      }
      if (active.wireId === undefined || message.id !== active.wireId || message.method !== undefined) return;
      if (message.error !== undefined || active.result !== null) { active.invalid = true; return; }
      active.result = structuredClone(record(message.result));
    },
    /** Status fields for the active (or last) turn; empty when no valid receipt exists. */
    statusFields(): { piPromptReceipt?: PiPromptReceipt; cursorPromptReceipt?: CursorPromptReceipt } {
      if (!active || active.invalid || active.result === null) return {};
      const result = active.result;
      if (agent === "pi") {
        const receipt = parsePiPromptReceipt(record(record(result.usage)._meta).paperclipPi);
        return receipt ? { piPromptReceipt: { request_id: active.requestId, receipt } } : {};
      }
      // Cursor's receipt is diagnostic and only meaningful for a settled turn.
      if (result.stopReason !== "end_turn" && result.stopReason !== "cancelled") return {};
      const receipt = record(result._meta).paperclipCursorUsage;
      return receipt === undefined ? {} : { cursorPromptReceipt: { request_id: active.requestId, receipt: structuredClone(receipt) } };
    },
  };
}
