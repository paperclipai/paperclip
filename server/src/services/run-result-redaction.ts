import { redactSensitiveText } from "../redaction.js";

/**
 * Redact token-shaped text in an adapter result before it is persisted.
 *
 * Read-time redaction (run-secret-redaction) masks only the secret values that
 * Paperclip injected into the run. An agent process can also print a credential
 * that it obtained on the host (for example a CLI login token) into its
 * captured stdout, and adapters store that output in the result. Without a
 * write-time pass, such a value is stored as written and returned as written.
 *
 * This walks plain objects and arrays and applies the shared text scanner to
 * every string leaf. Keys, numbers, booleans and the object shape are kept, so
 * structured result fields stay readable.
 */
export function redactRunResultSecrets<T>(value: T, depth = 0): T {
  if (depth > 64) return value;
  if (typeof value === "string") return redactSensitiveText(value) as T;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const redacted = redactRunResultSecrets(item, depth + 1);
      if (redacted !== item) changed = true;
      return redacted;
    });
    return (changed ? next : value) as T;
  }
  if (value !== null && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const redacted = redactRunResultSecrets(item, depth + 1);
      if (redacted !== item) changed = true;
      next[key] = redacted;
    }
    return (changed ? next : value) as T;
  }
  return value;
}
