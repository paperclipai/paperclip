import { REDACTED_EVENT_VALUE, redactSensitiveText } from "../redaction.js";

/**
 * Redact token-shaped text in an adapter result before it is persisted.
 *
 * Read-time redaction (run-secret-redaction) masks only the secret values that
 * Paperclip injected into the run. An agent process can also print a credential
 * that it obtained on the host (for example a CLI login token) into its
 * captured stdout, and adapters store that output in the result. Without a
 * write-time pass, such a value is stored as written and returned as written.
 *
 * This walks plain objects and arrays. Every string leaf goes through the
 * shared text scanner, and a string under a credential-named key is masked
 * whole. Keys, numbers, booleans and the object shape are kept.
 *
 * Captured output can be megabytes and can hold very long runs of non-space
 * characters (base64 blobs). The shared scanner's unanchored expressions are
 * quadratic on such runs, so a run longer than LONG_SEGMENT only gets the
 * prefix-anchored token expressions below, which stay linear.
 */
const LONG_SEGMENT = 1024;
const LONG_SEGMENT_RE = new RegExp(String.raw`\S{${LONG_SEGMENT + 1},}`, "g");
const HAS_LONG_SEGMENT_RE = new RegExp(String.raw`\S{${LONG_SEGMENT + 1}}`);
const PLACEHOLDER_RE = /\u0000(\d+)\u0000/g;

// Prefix-anchored credential shapes: each match attempt fails fast at a position without the literal prefix.
const LINEAR_TOKEN_RES = [
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

function redactLinear(input: string): string {
  return LINEAR_TOKEN_RES.reduce((text, re) => text.replace(re, REDACTED_EVENT_VALUE), input);
}

function redactString(input: string): string {
  if (!HAS_LONG_SEGMENT_RE.test(input)) {
    // The shared scanner has no fine-grained PAT shape; the linear pass adds it.
    return redactLinear(redactSensitiveText(input));
  }
  if (input.includes("\u0000")) return redactLinear(input);
  const long: string[] = [];
  const masked = input.replace(LONG_SEGMENT_RE, (segment) => {
    long.push(redactLinear(segment));
    return `\u0000${long.length - 1}\u0000`;
  });
  return redactLinear(redactSensitiveText(masked)).replace(PLACEHOLDER_RE, (match, index: string) => long[Number(index)] ?? match);
}

const CREDENTIAL_KEYS = new Set([
  "token", "accesstoken", "refreshtoken", "idtoken", "authtoken", "bearertoken", "sessiontoken",
  "apikey", "secret", "clientsecret", "password", "passwd", "authorization", "cookie", "privatekey",
]);

function isCredentialKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, "");
  return CREDENTIAL_KEYS.has(normalized) || /(?:token|secret|password|apikey)$/.test(normalized);
}

export function redactRunResultSecrets<T>(value: T, depth = 0, key: string | null = null): T {
  if (depth > 64) return value;
  if (typeof value === "string") {
    if (key !== null && value.length >= 8 && isCredentialKey(key)) return REDACTED_EVENT_VALUE as T;
    return redactString(value) as T;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const redacted = redactRunResultSecrets(item, depth + 1, null);
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
    for (const [entryKey, item] of Object.entries(value as Record<string, unknown>)) {
      const redacted = redactRunResultSecrets(item, depth + 1, entryKey);
      if (redacted !== item) changed = true;
      // defineProperty keeps an own `__proto__` key as data instead of calling the prototype setter.
      Object.defineProperty(next, entryKey, { value: redacted, enumerable: true, writable: true, configurable: true });
    }
    return (changed ? next : value) as T;
  }
  return value;
}
