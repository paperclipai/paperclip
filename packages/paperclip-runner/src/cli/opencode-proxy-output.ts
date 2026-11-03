// Runner normalizes each text delta with a 4,000-character limit. A byte cap
// also stays inside that limit for Unicode without truncating a merged delta.
const MAX_TEXT_BYTES = 4_000;
const FLUSH_INTERVAL_MS = 50;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function streamedText(value: unknown) {
  const frame = record(value);
  const params = record(frame?.params);
  const item = record(params?.item);
  if (frame?.method !== "item/agentMessage/delta" || frame.id !== undefined || !params || !item
    || ![params.threadId, params.turnId, params.itemId].every(id => typeof id === "string" && id.length > 0)
    || !["agentMessage", "text"].includes(String(params.kind))
    || item.type !== "agentMessage" || typeof params.delta !== "string"
    || params.text !== params.delta || item.text !== params.delta) return null;
  // Compare every non-text field so batching never changes item, turn,
  // channel, or any other metadata boundary.
  const key = JSON.stringify({ ...frame, params: { ...params, text: null, delta: null, item: { ...item, text: null } } });
  return { frame, params, item, key, text: params.delta };
}

/** Avoid making an MCP call wait behind a durable write for every text token. */
export function createOpenCodeProxyOutput(write: (frame: unknown) => void) {
  let pending: ReturnType<typeof streamedText> = null;
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const current = pending;
    pending = null;
    bytes = 0;
    if (current) write({ ...current.frame, params: { ...current.params,
      text: current.text, delta: current.text, item: { ...current.item, text: current.text } } });
  };
  return {
    send(frame: unknown): void {
      const text = streamedText(frame);
      if (!text) {
        flush();
        write(frame);
        return;
      }
      const size = Buffer.byteLength(text.text);
      if (pending && (pending.key !== text.key || bytes + size > MAX_TEXT_BYTES)) flush();
      if (size > MAX_TEXT_BYTES) {
        write(frame);
        return;
      }
      if (pending) pending.text += text.text;
      else pending = text;
      bytes += size;
      if (!timer) {
        timer = setTimeout(flush, FLUSH_INTERVAL_MS);
        timer.unref();
      }
    },
    flush,
  };
}
