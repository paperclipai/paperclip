/**
 * Safe pino serializers for error logging.
 *
 * Regression context: SCR-4 / SCR-5. Connection-level 500s (e.g. a raw
 * postgres-js error thrown out of a dead-socket `db.transaction()`) were
 * silently dropped from `server.log`. The raw driver error can carry circular
 * references (connection/query back-refs) or property getters that throw, so
 * pino's default error serialization could itself throw — and a throwing
 * serializer takes the whole log line down with it. The result: a 500 went out
 * to the client with no stack ever written to disk, leaving the failure
 * un-traced.
 *
 * These serializers are deliberately defensive: they extract only the stable,
 * always-serializable fields (name/message/stack and a couple of well-known
 * driver codes) and wrap everything in try/catch so a hostile error object can
 * never prevent the line from being written.
 */

interface SerializedError {
  type?: string;
  message: string;
  stack?: string;
  code?: string | number;
  errno?: string | number;
  details?: unknown;
}

const UNSERIALIZABLE: SerializedError = Object.freeze({ message: "<unserializable error>" });

function pickPrimitive(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

/**
 * Pull the stable identifying fields off an Error-like value (a real `Error`
 * instance or the plain `{ message, stack, name }` shape attached by the error
 * handler's `errorContext`) without traversing its possibly circular /
 * getter-throwing graph. Never throws — that is the whole point: a throwing
 * serializer drops the entire log line, which is how the SCR-4 connection-level
 * 500s went un-traced.
 */
export function safeErrSerializer(err: unknown): SerializedError {
  if (err == null) return { message: "<no error>" };
  try {
    if (err instanceof Error || (typeof err === "object")) {
      const anyErr = err as Record<string, unknown>;
      const out: SerializedError = {
        message:
          typeof anyErr.message === "string" ? anyErr.message : String(err),
      };
      const type = typeof anyErr.name === "string" ? anyErr.name : undefined;
      if (type) out.type = type;
      if (typeof anyErr.stack === "string") out.stack = anyErr.stack;
      // postgres-js / Node socket errors expose these as plain primitives.
      const code = pickPrimitive(anyErr.code);
      if (code !== undefined) out.code = code;
      const errno = pickPrimitive(anyErr.errno);
      if (errno !== undefined) out.errno = errno;
      if (anyErr.details !== undefined) out.details = anyErr.details;
      return out;
    }
    return { message: String(err) };
  } catch {
    return UNSERIALIZABLE;
  }
}
