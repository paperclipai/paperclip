import { createHash } from "node:crypto";

const SCHEMA = "paperclip.kimi.instructions.v1";
const MAX_BYTES = 32 * 1024;

export function kimiInstructionBinding(content: string) {
  if (typeof content !== "string" || content.includes("\0") || Buffer.from(content).toString("utf8") !== content || Buffer.byteLength(content) > MAX_BYTES) {
    throw new Error("Kimi Code instructions exceed their bounded size or contain NUL");
  }
  const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const byteLength = Buffer.byteLength(content);
  return { payload: JSON.stringify({ schema: SCHEMA, content, digest, byteLength }), digest, byteLength };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function createKimiInstructionAdmission(content: string) {
  const expected = kimiInstructionBinding(content);
  let current: { sessionId: string | null; error: Error | null } | null = null;
  const failure = (message: string) => new Error(`Kimi Code instruction admission failed: ${message}`);
  const assertReady = () => {
    if (current?.error) throw current.error;
    if (!current?.sessionId) throw failure("provider did not acknowledge the composed instructions");
  };
  return {
    assertReady,
    createGuard() {
      const state = { sessionId: null as string | null, error: null as Error | null };
      current = state;
      const pending = new Map<string | number, { method: string; sessionId: unknown }>();
      return (direction: "inbound" | "outbound", value: unknown): void => {
        if (current !== state) throw failure("connection authority was replaced");
        if (state.error) throw state.error;
        const message = record(value);
        try {
          if (direction === "outbound") {
            if (["session/new", "session/load", "session/resume"].includes(String(message.method))) {
              if ((typeof message.id !== "string" && typeof message.id !== "number") || pending.size !== 0) throw failure("session admission request is ambiguous");
              state.sessionId = null;
              pending.set(message.id, { method: String(message.method), sessionId: record(message.params).sessionId });
            } else if (message.method === "session/prompt") {
              assertReady();
              if (record(message.params).sessionId !== state.sessionId) throw failure("prompt belongs to an unacknowledged session");
            }
            return;
          }
          if (message.method !== undefined || (typeof message.id !== "string" && typeof message.id !== "number")) return;
          const request = pending.get(message.id);
          if (!request) return;
          pending.delete(message.id);
          if (message.error !== undefined) return;
          const result = record(message.result);
          const ack = record(record(result._meta).paperclipKimiInstructions);
          const sessionId = request.method === "session/new" ? result.sessionId : request.sessionId;
          if (ack.schema !== SCHEMA || ack.digest !== expected.digest || ack.byteLength !== expected.byteLength
            || typeof sessionId !== "string" || !sessionId.trim() || ack.sessionId !== sessionId
            || typeof ack.effectiveDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(ack.effectiveDigest)
            || !Number.isSafeInteger(ack.effectiveByteLength) || (ack.effectiveByteLength as number) < expected.byteLength) {
            throw failure("native instruction acknowledgment is missing or mismatched");
          }
          state.sessionId = sessionId;
        } catch (error) {
          state.error = error instanceof Error ? error : failure("invalid acknowledgment");
          throw state.error;
        }
      };
    },
  };
}
