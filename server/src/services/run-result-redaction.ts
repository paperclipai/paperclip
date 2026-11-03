import { randomUUID } from "node:crypto";
import { REDACTED_EVENT_VALUE, redactSensitiveText } from "../redaction.js";

const LONG_SEGMENT = 1024;
const LONG_SEGMENT_RE = new RegExp(String.raw`[A-Za-z0-9_-]{${LONG_SEGMENT + 1},}`, "g");
const HAS_LONG_SEGMENT_RE = new RegExp(String.raw`[A-Za-z0-9_-]{${LONG_SEGMENT + 1}}`);
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
  input = redactLinear(input);
  if (!HAS_LONG_SEGMENT_RE.test(input)) {
    return redactLinear(redactSensitiveText(input));
  }
  let marker: string;
  do { marker = `\u0000${randomUUID()}:`; } while (input.includes(marker));
  const long: string[] = [];
  const masked = input.replace(LONG_SEGMENT_RE, segment => {
    long.push(segment);
    return `${marker}${long.length - 1}\u0000`;
  });
  const placeholders = new RegExp(`${marker}(\\d+)\u0000`, "g");
  return redactLinear(redactSensitiveText(masked)).replace(placeholders, (match, index: string) => long[Number(index)] ?? match);
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
      Object.defineProperty(next, entryKey, { value: redacted, enumerable: true, writable: true, configurable: true });
    }
    return (changed ? next : value) as T;
  }
  return value;
}
