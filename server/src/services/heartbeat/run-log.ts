import { appendWithByteCap, MAX_EXCERPT_BYTES, parseObject } from "../../adapters/utils.js";
import { redactSensitiveText, sanitizeRecord } from "../../redaction.js";
import { redactCurrentUserText, redactCurrentUserValue, type CurrentUserRedactionOptions } from "../../log-redaction.js";

const MAX_PERSISTED_LOG_CHUNK_CHARS = 64 * 1024;
const MAX_RUN_EVENT_PAYLOAD_STRING_CHARS = 16 * 1024;
const MAX_RUN_EVENT_PAYLOAD_ARRAY_ITEMS = 50;
const MAX_RUN_EVENT_PAYLOAD_OBJECT_KEYS = 100;
const MAX_RUN_EVENT_PAYLOAD_DEPTH = 6;
const INLINE_BASE64_IMAGE_DATA_RE =
  /("type":"image","source":\{"type":"base64","data":")([A-Za-z0-9+/=]{1024,})(")/g;

export function appendExcerpt(prev: string, chunk: string) {
  return appendWithByteCap(prev, chunk, MAX_EXCERPT_BYTES);
}

function truncateRunEventString(value: string) {
  if (value.length <= MAX_RUN_EVENT_PAYLOAD_STRING_CHARS) return value;
  const omittedChars = value.length - MAX_RUN_EVENT_PAYLOAD_STRING_CHARS;
  return `${value.slice(0, MAX_RUN_EVENT_PAYLOAD_STRING_CHARS)}\n[truncated ${omittedChars} chars]`;
}

function boundRunEventValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") {
    return truncateRunEventString(value);
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_RUN_EVENT_PAYLOAD_DEPTH) {
      return {
        _truncated: true,
        type: "array",
        originalLength: value.length,
      };
    }
    const bounded = value
      .slice(0, MAX_RUN_EVENT_PAYLOAD_ARRAY_ITEMS)
      .map((entry) => boundRunEventValue(entry, depth + 1, seen));
    if (value.length > MAX_RUN_EVENT_PAYLOAD_ARRAY_ITEMS) {
      bounded.push({
        _truncated: true,
        omittedItems: value.length - MAX_RUN_EVENT_PAYLOAD_ARRAY_ITEMS,
      });
    }
    return bounded;
  }
  if (typeof value !== "object" || value === undefined) {
    return null;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  const entries = Object.entries(value as Record<string, unknown>);
  if (depth >= MAX_RUN_EVENT_PAYLOAD_DEPTH) {
    const bounded = {
      _truncated: true,
      type: "object",
      keys: entries.map(([key]) => key).slice(0, 20),
    };
    seen.delete(value);
    return bounded;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entryValue] of entries.slice(
    0,
    MAX_RUN_EVENT_PAYLOAD_OBJECT_KEYS,
  )) {
    out[key] = boundRunEventValue(entryValue, depth + 1, seen);
  }
  if (entries.length > MAX_RUN_EVENT_PAYLOAD_OBJECT_KEYS) {
    out._truncated = true;
    out._omittedKeys = entries.length - MAX_RUN_EVENT_PAYLOAD_OBJECT_KEYS;
  }
  seen.delete(value);
  return out;
}

export function boundHeartbeatRunEventPayloadForStorage(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const bounded = boundRunEventValue(payload, 0, new WeakSet());
  return parseObject(bounded) ?? { _truncated: true };
}

function redactInlineBase64ImageData(chunk: string) {
  return chunk.replace(
    INLINE_BASE64_IMAGE_DATA_RE,
    (_match, prefix: string, data: string, suffix: string) =>
      `${prefix}[omitted base64 image data: ${data.length} chars]${suffix}`,
  );
}

export function compactRunLogChunk(
  chunk: string,
  maxChars = MAX_PERSISTED_LOG_CHUNK_CHARS,
) {
  const normalized = redactSensitiveText(redactInlineBase64ImageData(chunk));
  if (normalized.length <= maxChars) return normalized;

  const headChars = Math.max(0, Math.floor(maxChars * 0.6));
  const tailChars = Math.max(0, Math.floor(maxChars * 0.25));
  const omittedChars = Math.max(0, normalized.length - headChars - tailChars);
  const marker = `\n[paperclip truncated run log chunk: omitted ${omittedChars} chars]\n`;
  return `${normalized.slice(0, headChars)}${marker}${normalized.slice(normalized.length - tailChars)}`;
}


interface CanonicalNativeLogRedaction {
  redactIdentity: <T>(value: T) => T;
  currentUser: CurrentUserRedactionOptions;
}

function omitCanonicalImageData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitCanonicalImageData);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const result = Object.fromEntries(Object.entries(object).map(([key, child]) =>
    [key, omitCanonicalImageData(child)]));
  const source = object.source as Record<string, unknown> | undefined;
  if (object.type === "image" && source?.type === "base64" &&
    typeof source.data === "string" && /^[A-Za-z0-9+/=]{1024,}$/.test(source.data)) {
    result.source = { ...(result.source as Record<string, unknown>),
      data: `[omitted base64 image data: ${source.data.length} chars]` };
  }
  return result;
}

/** Only complete envelopes supplied by the durable native exporter use this path.
 * Redact complete JSON values before encoding so quoted secrets cannot damage
 * the record's structure. Image omission uses the existing field/length policy.
 * The object writer separately bounds the complete encoded outer record.
 */
export function redactCanonicalNativeRunLogChunk(chunk: string, options: CanonicalNativeLogRedaction) {
  const envelope = JSON.parse(chunk);
  if (envelope?.type !== "paperclip.prp.event" || !envelope.event ||
    typeof envelope.event !== "object" || Array.isArray(envelope.event))
    throw new Error("invalid_canonical_native_run_log_envelope");
  const projected = redactCurrentUserValue(
    options.redactIdentity(omitCanonicalImageData(envelope)), options.currentUser,
  );
  return `${JSON.stringify(sanitizeRecord(projected as Record<string, unknown>))}\n`;
}

/** New complete-value forms first; old text projections are computed only when
 * an archive needs them. An old malformed projection never repairs evidence.
 */
export function* canonicalNativeRunLogRedactionForms(chunk: string, options: CanonicalNativeLogRedaction) {
  for (const enabled of [false, true])
    yield redactCanonicalNativeRunLogChunk(chunk, {
      ...options, currentUser: { ...options.currentUser, enabled },
    });
  for (const enabled of [false, true])
    yield compactRunLogChunk(redactCurrentUserText(options.redactIdentity(chunk), {
      ...options.currentUser, enabled,
    }), Number.MAX_SAFE_INTEGER);
}
