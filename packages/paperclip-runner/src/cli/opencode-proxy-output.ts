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

export interface OpenCodeProxyFrameOptions {
  /**
   * Abandons the frame while it is still queued in this process. Only a
   * request whose sender can tolerate never being delivered may pass one.
   */
  signal?: AbortSignal;
  /** Called once when the frame is dropped before reaching the stream. */
  onAbandoned?: () => void;
}

/** Avoid making an MCP call wait behind a durable write for every text token. */
export function createOpenCodeProxyOutput(write: (frame: unknown, options?: OpenCodeProxyFrameOptions) => void) {
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
    send(frame: unknown, options?: OpenCodeProxyFrameOptions): void {
      const text = streamedText(frame);
      if (!text) {
        flush();
        write(frame, options);
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

export interface OpenCodeProxyFrameSink {
  write(chunk: string): boolean;
  once(event: "drain", listener: () => void): unknown;
}

type QueuedFrame = { line: string; options?: OpenCodeProxyFrameOptions; onAbort?: () => void };

/**
 * Writes newline-delimited frames to a stream without handing it more than its
 * own buffer accepts.
 *
 * runnerd reads this stream only as fast as its controller acknowledges earlier
 * events, so a backlog can build here while OpenCode keeps working. Node would
 * otherwise buffer that backlog itself, and every frame in it would eventually
 * be delivered. Holding the backlog in this queue instead lets a request whose
 * MCP client has already given up (for example a timed-out tool call) be
 * dropped before runnerd can dispatch it. Order of delivered frames is kept.
 */
export function createBackpressuredFrameWriter(sink: OpenCodeProxyFrameSink) {
  const queue: QueuedFrame[] = [];
  let waitingForDrain = false;
  const release = (entry: QueuedFrame) => {
    if (entry.onAbort) entry.options?.signal?.removeEventListener("abort", entry.onAbort);
    entry.onAbort = undefined;
  };
  const abandon = (entry: QueuedFrame) => {
    release(entry);
    try { entry.options?.onAbandoned?.(); } catch { /* A sender callback never blocks later frames. */ }
  };
  const writeEntry = (entry: QueuedFrame): boolean => {
    release(entry);
    return sink.write(entry.line);
  };
  const pump = () => {
    while (!waitingForDrain && queue.length > 0) {
      const entry = queue.shift()!;
      if (entry.options?.signal?.aborted) {
        abandon(entry);
        continue;
      }
      if (!writeEntry(entry)) {
        waitingForDrain = true;
        sink.once("drain", () => {
          waitingForDrain = false;
          pump();
        });
      }
    }
  };
  return {
    write(frame: unknown, options?: OpenCodeProxyFrameOptions): void {
      if (options?.signal?.aborted) {
        try { options.onAbandoned?.(); } catch { /* See abandon(). */ }
        return;
      }
      const entry: QueuedFrame = { line: `${JSON.stringify(frame)}\n`, options };
      if (options?.signal) {
        entry.onAbort = () => {
          const index = queue.indexOf(entry);
          if (index < 0) return;
          queue.splice(index, 1);
          abandon(entry);
        };
        options.signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      queue.push(entry);
      pump();
    },
    /** Hands every remaining live frame to the stream, ignoring backpressure. */
    drain(): void {
      for (const entry of queue.splice(0)) {
        if (entry.options?.signal?.aborted) abandon(entry);
        else writeEntry(entry);
      }
    },
    get queuedFrames(): number {
      return queue.length;
    },
  };
}
