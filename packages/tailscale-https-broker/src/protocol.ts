/**
 * Versioned, length-bounded broker request protocol with a strict schema
 * (PAP-17050 verdict requirement #5). Every request is decoded here before any
 * authorization or mutation logic runs. Malformed, oversized, wrong-version,
 * duplicate-key, and unknown-field requests are rejected without side effects.
 */
import { assertCanonicalPort } from "./integers.js";
import {
  DEFAULT_APP_PORT_MAX,
  DEFAULT_APP_PORT_MIN,
  DEFAULT_HMR_PORT_OFFSET,
} from "./port-policy.js";
import { parseJsonNoDuplicateKeys } from "./strict-json.js";
import {
  BROKER_PROTOCOL_VERSION,
  type BrokerRequest,
  type OwnedListener,
} from "./types.js";

/** Hard cap on a single request frame (bytes). Bounds memory + slowloris. */
export const MAX_REQUEST_BYTES = 8 * 1024;

/** Max listeners in one expose request (app + HMR companion). */
export const MAX_LISTENERS_PER_REQUEST = 2;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const HANDLE_RE = /^[A-Za-z0-9_-]{16,128}$/;

const ALLOWED_PURPOSES: ReadonlySet<OwnedListener["purpose"]> = new Set([
  "app",
  "vite_hmr",
]);

export class ProtocolError extends Error {
  constructor(
    readonly code:
      | "unsupported_version"
      | "malformed_request"
      | "unknown_operation"
      | "invalid_runtime_id"
      | "invalid_port",
    message: string,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolError("malformed_request", "request must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requireStringField(
  obj: Record<string, unknown>,
  field: string,
  re: RegExp,
  code: ProtocolError["code"],
  requestId: string | null,
): string {
  const value = obj[field];
  if (typeof value !== "string" || !re.test(value)) {
    throw new ProtocolError(code, `invalid or missing field: ${field}`, requestId);
  }
  return value;
}

/**
 * Decode a raw request frame (utf-8 JSON) into a validated BrokerRequest.
 * Throws ProtocolError on any violation; never mutates state.
 */
export function decodeRequest(frame: Buffer | string): BrokerRequest {
  const buf = typeof frame === "string" ? Buffer.from(frame, "utf8") : frame;
  if (buf.byteLength === 0) {
    throw new ProtocolError("malformed_request", "empty request frame");
  }
  if (buf.byteLength > MAX_REQUEST_BYTES) {
    throw new ProtocolError("malformed_request", "request frame exceeds size limit");
  }

  let parsed: unknown;
  try {
    parsed = parseJsonNoDuplicateKeys(buf.toString("utf8"));
  } catch (error) {
    throw new ProtocolError(
      "malformed_request",
      `invalid JSON: ${(error as Error).message}`,
    );
  }

  const obj = asObject(parsed);

  if (obj.v !== BROKER_PROTOCOL_VERSION) {
    throw new ProtocolError(
      "unsupported_version",
      `unsupported protocol version: ${String(obj.v)}`,
    );
  }

  const requestId = requireStringField(obj, "requestId", REQUEST_ID_RE, "malformed_request", null);

  const op = obj.op;
  if (op !== "reserve" && op !== "expose" && op !== "remove" && op !== "list") {
    throw new ProtocolError("unknown_operation", `unknown operation: ${String(op)}`, requestId);
  }

  if (op === "list") {
    assertExactKeys(obj, ["v", "op", "requestId"], requestId);
    return { op: "list", requestId };
  }

  if (op === "remove" || op === "expose") {
    assertExactKeys(obj, ["v", "op", "requestId", "runtimeId", "handle"], requestId);
    const runtimeId = requireStringField(obj, "runtimeId", UUID_RE, "invalid_runtime_id", requestId);
    const handle = requireStringField(obj, "handle", HANDLE_RE, "malformed_request", requestId);
    return { op, requestId, runtimeId, handle };
  }

  // reserve
  assertExactKeys(obj, ["v", "op", "requestId", "runtimeId", "listeners"], requestId);
  const runtimeId = requireStringField(obj, "runtimeId", UUID_RE, "invalid_runtime_id", requestId);
  const rawListeners = obj.listeners;
  if (!Array.isArray(rawListeners) || rawListeners.length === 0) {
    throw new ProtocolError("malformed_request", "listeners must be a non-empty array", requestId);
  }
  if (rawListeners.length > MAX_LISTENERS_PER_REQUEST) {
    throw new ProtocolError("malformed_request", "too many listeners in request", requestId);
  }
  const listeners: OwnedListener[] = rawListeners.map((entry) => {
    const listener = asObject(entry);
    assertExactKeys(listener, ["purpose", "port"], requestId);
    const purpose = listener.purpose;
    if (typeof purpose !== "string" || !ALLOWED_PURPOSES.has(purpose as OwnedListener["purpose"])) {
      throw new ProtocolError("malformed_request", "invalid listener purpose", requestId);
    }
    let port: number;
    try {
      port = assertCanonicalPort(listener.port);
    } catch (error) {
      throw new ProtocolError("invalid_port", (error as Error).message, requestId);
    }
    return { purpose: purpose as OwnedListener["purpose"], port };
  });

  // Reject duplicate ports / duplicate purposes within one request.
  const ports = new Set(listeners.map((l) => l.port));
  const purposes = new Set(listeners.map((l) => l.purpose));
  if (ports.size !== listeners.length || purposes.size !== listeners.length) {
    throw new ProtocolError("malformed_request", "duplicate listener port or purpose", requestId);
  }

  const app = listeners.find((listener) => listener.purpose === "app");
  const hmr = listeners.find((listener) => listener.purpose === "vite_hmr");
  if (!app || app.port < DEFAULT_APP_PORT_MIN || app.port > DEFAULT_APP_PORT_MAX) {
    throw new ProtocolError("invalid_port", "an app listener in the dedicated app range is required", requestId);
  }
  if (hmr && hmr.port !== app.port + DEFAULT_HMR_PORT_OFFSET) {
    throw new ProtocolError("invalid_port", "vite_hmr must be the app port companion", requestId);
  }

  return { op: "reserve", requestId, runtimeId, listeners };
}

function assertExactKeys(
  obj: Record<string, unknown>,
  allowed: string[],
  requestId: string | null,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      throw new ProtocolError("malformed_request", `unknown field: ${key}`, requestId);
    }
  }
}
