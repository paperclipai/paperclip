/**
 * Wire protocol for the Tailscale HTTPS broker Unix socket.
 *
 * Requirement #5 (protocol abuse / local DoS) and #4 (injection) of the
 * threat-model verdict: the protocol is versioned, length-bounded, strictly
 * schema-checked, and rejects duplicate JSON keys and unknown fields. One
 * length-prefixed request/response per connection keeps parsing trivial and
 * makes resource bounds explicit.
 *
 * Framing: a single line of UTF-8 JSON terminated by `\n`, at most
 * {@link MAX_FRAME_BYTES}. Responses are the same shape.
 */

export const PROTOCOL_VERSION = 1 as const;

/** Hard cap on a single request/response frame. Anything larger is refused. */
export const MAX_FRAME_BYTES = 8 * 1024;

export type BrokerOperation = "list" | "expose" | "remove";

export interface ExposeRequest {
  v: 1;
  op: "expose";
  /** Opaque runtime-service UUID the caller claims to act for. */
  runtimeId: string;
  /** Same value for public and target port (same-number loopback mapping). */
  port: number;
  /** Loopback target origin, e.g. "http://127.0.0.1:39001". */
  target: string;
  /** Broker-issued reservation token proving the port was reserved for this runtime. */
  reservation: string;
}

export interface RemoveRequest {
  v: 1;
  op: "remove";
  /** Broker-issued lease handle returned by a prior `expose`. */
  handle: string;
}

export interface ListRequest {
  v: 1;
  op: "list";
}

export type BrokerRequest = ExposeRequest | RemoveRequest | ListRequest;

export interface BrokerErrorResponse {
  ok: false;
  code: string;
  message: string;
}

export interface BrokerOkResponse {
  ok: true;
  result: unknown;
}

export type BrokerResponse = BrokerOkResponse | BrokerErrorResponse;

export class ProtocolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

/**
 * Parse a single JSON object, rejecting duplicate keys. `JSON.parse` silently
 * keeps the last value for a duplicated key, which an attacker can use to smuggle
 * a value past a validator that inspected the first. We detect duplicates with a
 * reviver that counts key occurrences per container.
 */
export function parseJsonNoDuplicateKeys(text: string): unknown {
  // Track duplicate keys via a reviver. The reviver runs bottom-up; to detect
  // duplicates we re-scan using a lightweight structural check: JSON.parse with a
  // reviver cannot see raw duplicates, so we compare the parsed key count against
  // a raw key count obtained from a second, strict pass.
  const seenGuard = new WeakSet<object>();
  const parsed = JSON.parse(text, function reviver(this: unknown, _key, value) {
    if (value && typeof value === "object") {
      if (seenGuard.has(value as object)) {
        throw new ProtocolError("duplicate_object", "cyclic or shared object in payload");
      }
      seenGuard.add(value as object);
    }
    return value;
  });
  assertNoDuplicateKeysRaw(text);
  return parsed;
}

/**
 * Structural raw scan that flags a duplicate key within any single object.
 * Uses a tokenizer restricted to well-formed JSON (the value already parsed via
 * JSON.parse, so we only need to detect repeated keys at the same nesting).
 */
function assertNoDuplicateKeysRaw(text: string): void {
  const stack: Array<Set<string>> = [];
  let i = 0;
  const n = text.length;
  let expectKey = false;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      // read a string token
      let j = i + 1;
      let str = "";
      while (j < n) {
        const c = text[j];
        if (c === "\\") {
          str += text[j] + text[j + 1];
          j += 2;
          continue;
        }
        if (c === '"') break;
        str += c;
        j += 1;
      }
      const endQuote = j;
      // Is this string a key? It's a key if the next non-ws char is ':'.
      let k = endQuote + 1;
      while (k < n && /\s/.test(text[k])) k += 1;
      if (text[k] === ":" && stack.length > 0 && expectKey) {
        const top = stack[stack.length - 1];
        if (top.has(str)) {
          throw new ProtocolError("duplicate_key", `duplicate JSON key ${JSON.stringify(str)}`);
        }
        top.add(str);
        expectKey = false;
      }
      i = endQuote + 1;
      continue;
    }
    if (ch === "{") {
      stack.push(new Set());
      expectKey = true;
    } else if (ch === "}") {
      stack.pop();
    } else if (ch === ",") {
      if (stack.length > 0) expectKey = true;
    } else if (ch === "[") {
      expectKey = false;
    }
    i += 1;
  }
}

const ALLOWED_KEYS: Record<BrokerOperation, Set<string>> = {
  list: new Set(["v", "op"]),
  expose: new Set(["v", "op", "runtimeId", "port", "target", "reservation"]),
  remove: new Set(["v", "op", "handle"]),
};

function assertNoUnknownKeys(op: BrokerOperation, obj: Record<string, unknown>): void {
  const allowed = ALLOWED_KEYS[op];
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new ProtocolError("unknown_field", `unknown field ${JSON.stringify(key)} for op ${op}`);
  }
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ProtocolError("bad_field", `${field} must be a string`);
  if (value.length === 0 || value.length > 512) throw new ProtocolError("bad_field", `${field} has invalid length`);
  return value;
}

/**
 * Validate a decoded request frame into a typed {@link BrokerRequest}.
 * Does NOT authorize the request — it only enforces protocol shape.
 */
export function validateRequest(raw: unknown): BrokerRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProtocolError("bad_request", "request must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.v !== PROTOCOL_VERSION) {
    throw new ProtocolError("bad_version", `unsupported protocol version ${String(obj.v)}`);
  }
  const op = obj.op;
  if (op !== "list" && op !== "expose" && op !== "remove") {
    throw new ProtocolError("bad_op", `unknown operation ${JSON.stringify(op)}`);
  }
  assertNoUnknownKeys(op, obj);
  if (op === "list") return { v: 1, op };
  if (op === "remove") {
    return { v: 1, op, handle: asString(obj.handle, "handle") };
  }
  // expose: port is validated canonically downstream; keep it as-is here so the
  // policy layer performs the authoritative canonical parse.
  return {
    v: 1,
    op,
    runtimeId: asString(obj.runtimeId, "runtimeId"),
    port: obj.port as number,
    target: asString(obj.target, "target"),
    reservation: asString(obj.reservation, "reservation"),
  };
}

/** Decode a length-bounded UTF-8 frame into a validated request. */
export function decodeRequestFrame(frame: Buffer | string): BrokerRequest {
  const buf = typeof frame === "string" ? Buffer.from(frame, "utf8") : frame;
  if (buf.length > MAX_FRAME_BYTES) {
    throw new ProtocolError("frame_too_large", `request frame ${buf.length} bytes exceeds ${MAX_FRAME_BYTES}`);
  }
  const text = buf.toString("utf8").replace(/\n$/, "");
  if (text.includes("\n")) throw new ProtocolError("bad_frame", "request frame contains embedded newline");
  const parsed = parseJsonNoDuplicateKeys(text);
  return validateRequest(parsed);
}

export function encodeResponse(response: BrokerResponse): Buffer {
  const line = `${JSON.stringify(response)}\n`;
  const buf = Buffer.from(line, "utf8");
  if (buf.length > MAX_FRAME_BYTES) {
    // Responses are constructed by the broker and should always be small; guard anyway.
    const fallback = Buffer.from(`${JSON.stringify({ ok: false, code: "response_too_large", message: "response exceeded frame limit" })}\n`, "utf8");
    return fallback;
  }
  return buf;
}
