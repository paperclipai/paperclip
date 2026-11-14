const SENSITIVE_KEY = /^(apiid|apihash|api_id|api_hash|session|password|token|secret|authkey|sessionsecretid)$/i;
const SENSITIVE_FRAGMENT = /api[_-]?hash|api[_-]?id|session|password|tg:\/\/login|secret_ref|authkey/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key.replaceAll(/[^a-z0-9]/gi, ""));
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length > 24 && SENSITIVE_FRAGMENT.test(value)) return "[redacted]";
    if (value.startsWith("tg://login")) return "[redacted-qr]";
    return value;
  }
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? "[redacted]" : redactValue(entry);
    }
    return out;
  }
  return value;
}

export function containsSecretMaterial(haystack: unknown, secrets: readonly string[]): boolean {
  if (secrets.length === 0) return false;
  const serialized = stringifyForSecretScan(haystack);
  return secrets.some((secret) => secret.length > 0 && serialized.includes(secret));
}

export function stringifyForSecretScan(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
