const TRACE_CHANNELS = new Set([
  "rust_native",
  "typescript_runnerd_rehydration",
  "typescript_opencode_native",
  "typescript_acpx_native",
]);
const DIRECTIONS = new Set([
  "client_to_provider",
  "provider_to_client",
  "provider_stderr",
]);
const MESSAGE_TYPES = new Set([
  "request",
  "response",
  "notification",
  "error",
  "event",
  "serverRequest",
]);
const METHODS = new Set([
  "initialize",
  "initialized",
  "shutdown",
  "exit",
  "tools/list",
  "tools/call",
  "thread/start",
  "thread/resume",
  "thread/turn/start",
  "thread/turn/completed",
  "thread/turn/steer",
  "thread/turn/interrupt",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "thread/read",
  "turn/started",
  "turn/completed",
  "turn/failed",
  "item/started",
  "item/completed",
  "codex/event",
]);
const TRACE_STATUSES = new Set([
  "capturing",
  "complete",
  "incomplete",
  "truncated",
  "deleted",
  "expired",
]);
const MAX_FRAMES = 2_000;

type RecordLike = Record<string, unknown>;

function record(value: unknown): RecordLike | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : undefined;
}

function safeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function safeDigest(value: unknown): string | null {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/i.test(value)
    ? value
    : null;
}

function safeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function safeReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const fixed = new Set([
    "invalid_sidecar_record",
    "invalid_frame_metadata",
    "provider_frame_digest_mismatch",
    "trace_terminal_ack_missing",
    "trace_channel_incomplete",
    "provider_trace_max_bytes_exceeded",
    "trace_sidecar_missing",
  ]);
  if (fixed.has(value)) return value;
  const channelReason = /^(trace_channel_missing|trace_channel_ack_missing|trace_channel_ack_invalid|trace_debug_sequence_gap):(rust_native|typescript_runnerd_rehydration|typescript_opencode_native|typescript_acpx_native)$/;
  return channelReason.test(value) ? value : "redacted";
}

function frameSummary(value: unknown): RecordLike | null {
  const frame = record(value);
  if (!frame || frame.kind !== "frame") return null;
  const parsed = record(frame.parsed);
  const method = typeof parsed?.method === "string" && METHODS.has(parsed.method)
    ? parsed.method
    : undefined;
  const messageType = typeof parsed?.type === "string" && MESSAGE_TYPES.has(parsed.type)
    ? parsed.type
    : undefined;
  const jsonRpcId = safeCount(parsed?.id);
  return {
    ...(safeCount(frame.frameId) === null ? {} : { frameId: safeCount(frame.frameId) }),
    direction: typeof frame.direction === "string" && DIRECTIONS.has(frame.direction) ? frame.direction : "unknown",
    timestamp: safeTimestamp(frame.timestamp),
    channel: typeof frame.debugChannel === "string" && TRACE_CHANNELS.has(frame.debugChannel) ? frame.debugChannel : "unknown",
    sequence: safeCount(frame.debugSequence),
    size: safeCount(frame.byteLength),
    digest: safeDigest(frame.digest),
    ...(method ? { method } : {}),
    ...(messageType ? { messageType } : {}),
    ...(jsonRpcId === null ? {} : { jsonRpcId }),
  };
}

/** Extracts bounded, payload-free diagnostics from the redacted inspection API response. */
export function summarizeProviderTraceInspection(input: {
  httpStatus: number;
  inspection?: unknown;
}): RecordLike {
  if (!Number.isInteger(input.httpStatus) || input.httpStatus < 200 || input.httpStatus >= 300) {
    return { capture: "unavailable", httpStatus: safeCount(input.httpStatus) };
  }
  const body = record(input.inspection);
  if (!body) return { capture: "unavailable", reason: "invalid_inspection_response" };
  const trace = record(body.trace);
  if (!trace) return { capture: "missing", frameCount: 0, frames: [], omittedFrameCount: 0, truncated: false };
  const sourceEntries = Array.isArray(body.entries) ? body.entries : [];
  const frameTail: unknown[] = [];
  let frameTailStart = 0;
  let observedFrameCount = 0;
  for (const entry of sourceEntries) {
    if (record(entry)?.kind !== "frame") continue;
    observedFrameCount += 1;
    if (frameTail.length < MAX_FRAMES) {
      frameTail.push(entry);
    } else {
      frameTail[frameTailStart] = entry;
      frameTailStart = (frameTailStart + 1) % MAX_FRAMES;
    }
  }
  const orderedTail = frameTail.length < MAX_FRAMES
    ? frameTail
    : Array.from({ length: frameTail.length }, (_, index) => frameTail[(frameTailStart + index) % frameTail.length]);
  const frames = orderedTail.map(frameSummary).filter((frame): frame is RecordLike => frame !== null);
  const declaredCount = safeCount(trace.frameCount);
  const frameCount = Math.max(declaredCount ?? 0, observedFrameCount);
  const omittedFrameCount = Math.max(0, frameCount - frames.length);
  const status = typeof trace.status === "string" && TRACE_STATUSES.has(trace.status) ? trace.status : "unknown";
  return {
    capture: "captured",
    status,
    reason: safeReason(trace.reason),
    frameCount,
    byteCount: safeCount(trace.byteCount),
    digest: safeDigest(trace.digest),
    frames,
    omittedFrameCount,
    truncated: omittedFrameCount > 0 || status === "truncated",
  };
}
