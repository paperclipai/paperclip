/**
 * NDJSON turn-stream framing for the Capability live chat (track 7Q).
 *
 * One POST carries a whole turn. Before this the server awaited the terminal
 * artifact and answered once, so the browser could only reveal a finished
 * reply — which is exactly what the board rejected. The turn now answers with
 * an ordered sequence of newline-delimited frames written as the provider
 * produces them, and the final `settled` frame carries the same payload the
 * single JSON response used to carry. The last frame stays the authority: an
 * interim frame is a view of work in progress, never a substitute for it.
 *
 * NDJSON rather than SSE because the request is already a POST the client
 * consumes with `fetch`. `EventSource` cannot POST, and framing `data:` lines
 * by hand would buy nothing over one JSON object per line.
 *
 * This module is deliberately dependency-free — no Node built-ins, no view
 * types — so the browser bundle, the package server, and the smoke scripts can
 * all agree on the wire format without any of them dragging in the others.
 */

export const CAPABILITY_TURN_STREAM_SCHEMA = "paperclip.capability.turn-stream.v1" as const;

/** `no-transform` is the half that keeps an intermediary from coalescing frames. */
export const CAPABILITY_TURN_STREAM_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/x-ndjson; charset=utf-8",
  "cache-control": "no-store, no-transform",
  // Nginx and friends buffer proxied responses by default, which would hold
  // every frame until the turn ended and reproduce the reported symptom.
  "x-accel-buffering": "no",
});

export const CAPABILITY_TURN_STREAM_ACCEPT = "application/x-ndjson" as const;

/**
 * A frame line longer than this means the peer is not speaking this protocol
 * (or is trying to make the reader buffer without bound), so the decoder fails
 * rather than growing.
 */
export const CAPABILITY_TURN_STREAM_MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * Encoded UTF-8 length of a decoded string.
 *
 * The buffered-frame limit is named in bytes, so it has to be enforced in
 * bytes: `String#length` counts UTF-16 code units, which lets a frame of
 * multi-byte text run to roughly three times the stated cap before tripping it.
 * Counted rather than encoded, because the check runs on every chunk and the
 * point of the cap is to avoid allocating for an oversized frame.
 */
export function capabilityUtf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      // Surrogate pair: one code point, four bytes, two code units consumed.
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Why the server emitted an interim frame. Carried for observability only: the
 * client renders `view` the same way whatever produced it.
 */
export type CapabilityTurnStreamReason =
  | "open"
  | "delta"
  | "activity"
  | "stop_requested"
  | "terminal";

export interface CapabilityTurnStreamViewFrame<View> {
  schema: typeof CAPABILITY_TURN_STREAM_SCHEMA;
  type: "frame";
  /** Monotonic within one turn stream, starting at 1. */
  seq: number;
  reason: CapabilityTurnStreamReason;
  turnId: string | null;
  view: View;
}

export interface CapabilityTurnStreamSettledFrame<Payload> {
  schema: typeof CAPABILITY_TURN_STREAM_SCHEMA;
  type: "settled";
  seq: number;
  payload: Payload;
}

export interface CapabilityTurnStreamErrorFrame {
  schema: typeof CAPABILITY_TURN_STREAM_SCHEMA;
  type: "error";
  seq: number;
  error: string;
  message: string;
}

export type CapabilityTurnStreamFrame<View, Payload> =
  | CapabilityTurnStreamViewFrame<View>
  | CapabilityTurnStreamSettledFrame<Payload>
  | CapabilityTurnStreamErrorFrame;

export function isCapabilityTurnStreamTerminalFrame<View, Payload>(
  frame: CapabilityTurnStreamFrame<View, Payload>,
): frame is CapabilityTurnStreamSettledFrame<Payload> | CapabilityTurnStreamErrorFrame {
  return frame.type === "settled" || frame.type === "error";
}

export function encodeCapabilityTurnStreamFrame<View, Payload>(
  frame: CapabilityTurnStreamFrame<View, Payload>,
): string {
  return `${JSON.stringify(frame)}\n`;
}

export class CapabilityTurnStreamError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CapabilityTurnStreamError";
  }
}

function parseFrame<View, Payload>(line: string): CapabilityTurnStreamFrame<View, Payload> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new CapabilityTurnStreamError("stream_frame_invalid", "A turn frame was not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CapabilityTurnStreamError("stream_frame_invalid", "A turn frame was not an object.");
  }
  const frame = parsed as Partial<CapabilityTurnStreamFrame<View, Payload>>;
  if (frame.schema !== CAPABILITY_TURN_STREAM_SCHEMA) {
    throw new CapabilityTurnStreamError("stream_schema_unknown", "A turn frame used an unknown schema.");
  }
  if (frame.type !== "frame" && frame.type !== "settled" && frame.type !== "error") {
    throw new CapabilityTurnStreamError("stream_frame_invalid", "A turn frame used an unknown type.");
  }
  if (typeof frame.seq !== "number" || !Number.isInteger(frame.seq) || frame.seq < 1) {
    throw new CapabilityTurnStreamError("stream_frame_invalid", "A turn frame omitted its sequence.");
  }
  return frame as CapabilityTurnStreamFrame<View, Payload>;
}

export interface CapabilityTurnStreamDecoder<View, Payload> {
  /** Frames completed by this chunk, in wire order. */
  push(chunk: string): Array<CapabilityTurnStreamFrame<View, Payload>>;
  /** Frames completed by the end of the body; also rejects a truncated tail. */
  flush(): Array<CapabilityTurnStreamFrame<View, Payload>>;
}

/**
 * Incremental NDJSON reader. A chunk boundary can land anywhere, including
 * mid-frame, so the tail is held until its newline arrives; ordering is the
 * wire order, and `seq` is checked to be strictly increasing so a reordered or
 * replayed frame is a failure rather than a silently applied stale view.
 */
export function createCapabilityTurnStreamDecoder<View, Payload>(): CapabilityTurnStreamDecoder<
  View,
  Payload
> {
  let buffer = "";
  let lastSeq = 0;
  let terminal = false;

  function accept(line: string): CapabilityTurnStreamFrame<View, Payload> | null {
    const trimmed = line.trim();
    if (trimmed.length === 0) return null;
    if (terminal) {
      throw new CapabilityTurnStreamError(
        "stream_after_terminal",
        "A turn frame arrived after the terminal frame.",
      );
    }
    const frame = parseFrame<View, Payload>(trimmed);
    if (frame.seq <= lastSeq) {
      throw new CapabilityTurnStreamError(
        "stream_out_of_order",
        "A turn frame arrived out of order.",
      );
    }
    lastSeq = frame.seq;
    if (isCapabilityTurnStreamTerminalFrame(frame)) terminal = true;
    return frame;
  }

  return {
    push(chunk) {
      buffer += chunk;
      if (capabilityUtf8ByteLength(buffer) > CAPABILITY_TURN_STREAM_MAX_FRAME_BYTES) {
        throw new CapabilityTurnStreamError(
          "stream_frame_too_large",
          "A turn frame exceeded the stream frame limit.",
        );
      }
      const frames: Array<CapabilityTurnStreamFrame<View, Payload>> = [];
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const frame = accept(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (frame !== null) frames.push(frame);
        newline = buffer.indexOf("\n");
      }
      return frames;
    },
    flush() {
      const tail = buffer;
      buffer = "";
      const frame = tail.trim().length === 0 ? null : accept(tail);
      if (!terminal) {
        throw new CapabilityTurnStreamError(
          "stream_truncated",
          "The turn stream ended before a terminal frame.",
        );
      }
      return frame === null ? [] : [frame];
    },
  };
}

export interface CapabilityTurnStreamBodyLike {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
    releaseLock(): void;
  };
}

export interface CapabilityTurnStreamResponseLike {
  body: CapabilityTurnStreamBodyLike | null;
}

/**
 * Drives `onFrame` from a `fetch` response body and returns the settled
 * payload. An `error` frame is raised as a `CapabilityTurnStreamError` carrying the
 * server's own code, so a stream failure reads the same way as the JSON error
 * bodies the pre-turn checks still return.
 */
export async function readCapabilityTurnStream<View, Payload>(
  response: CapabilityTurnStreamResponseLike,
  onFrame: (frame: CapabilityTurnStreamViewFrame<View>) => void,
): Promise<Payload> {
  if (response.body === null) {
    throw new CapabilityTurnStreamError("stream_unreadable", "The turn response had no readable body.");
  }
  const decoder = createCapabilityTurnStreamDecoder<View, Payload>();
  const text = new TextDecoder();
  const reader = response.body.getReader();
  let settled: Payload | undefined;
  let settledSeen = false;

  function apply(frames: Array<CapabilityTurnStreamFrame<View, Payload>>): void {
    for (const frame of frames) {
      if (frame.type === "frame") {
        onFrame(frame);
      } else if (frame.type === "settled") {
        settled = frame.payload;
        settledSeen = true;
      } else {
        throw new CapabilityTurnStreamError(frame.error, frame.message);
      }
    }
  }

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value !== undefined) {
        apply(decoder.push(text.decode(chunk.value, { stream: true })));
      }
    }
    apply(decoder.push(text.decode()));
    apply(decoder.flush());
  } finally {
    reader.releaseLock();
  }

  if (!settledSeen) {
    throw new CapabilityTurnStreamError("stream_truncated", "The turn stream never settled.");
  }
  return settled as Payload;
}
