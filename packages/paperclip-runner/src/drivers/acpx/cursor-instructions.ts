import { createHash } from "node:crypto";

const SCHEMA = "paperclip.cursor.instructions.v1";
const MAX_BYTES = 32 * 1024;

export function cursorInstructionBinding(content: string): { payload: string; digest: string; byteLength: number } {
  if (typeof content !== "string" || content.includes("\0") || Buffer.byteLength(content) > MAX_BYTES) {
    throw new Error("Cursor instructions exceed their bounded size or contain NUL");
  }
  const digest = `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
  return { payload: JSON.stringify({ schema: SCHEMA, content, digest }), digest, byteLength: Buffer.byteLength(content) };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Each connection must acknowledge its exact instructions before any prompt. */
export function createCursorInstructionAdmission(content: string) {
  const expected = cursorInstructionBinding(content);
  let current: { sessionId: string | null; error: Error | null } | null = null;
  const failure = (message: string) => new Error(`Cursor instruction admission failed: ${message}`);
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
            if (message.method === "session/new" || message.method === "session/load") {
              if ((typeof message.id !== "string" && typeof message.id !== "number") || pending.size !== 0) {
                throw failure("session admission request is ambiguous");
              }
              state.sessionId = null;
              pending.set(message.id, { method: message.method, sessionId: record(message.params).sessionId });
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
          if (message.error !== undefined) return; // Preserve the provider's typed session error.
          const result = record(message.result);
          const ack = record(record(result._meta).paperclipCursorInstructions);
          if (ack.schema !== SCHEMA || ack.digest !== expected.digest || ack.byteLength !== expected.byteLength) {
            throw failure("provider acknowledgement is missing or does not match the composed instructions");
          }
          const sessionId = request.method === "session/new" ? result.sessionId : request.sessionId;
          if (typeof sessionId !== "string" || !sessionId.trim()) throw failure("acknowledgement has no session identity");
          state.sessionId = sessionId;
        } catch (error) {
          state.error = error instanceof Error ? error : failure("invalid acknowledgement");
          throw state.error;
        }
      };
    },
  };
}

/** Cold ACPX ensureSession can return only a disk record. Establish a real load
 * before admitting that handle; every later connection still gets its own guard.
 */
export async function admitCursorInstructions(
  admission: ReturnType<typeof createCursorInstructionAdmission>,
  input: { providerSpawned: boolean; load: () => Promise<void>; refreshCommand: () => Promise<void> },
): Promise<void> {
  if (!input.providerSpawned) {
    await input.load();
    admission.assertReady();
    // ACPX control calls close their temporary native connection. A subsequent
    // prompt needs a fresh verified command lease, never a consumed snapshot.
    await input.refreshCommand();
  } else admission.assertReady();
}
