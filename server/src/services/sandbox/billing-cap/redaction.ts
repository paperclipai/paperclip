/**
 * Phase 4A-S4 B2 (LET-367): credential-shape parser for vendor cost-line
 * responses.
 *
 * S3 AC #6 + AC §Constraints: cost figures are NEVER keyed to the raw API key
 * value; we key on provider + run id only. If the vendor response contains a
 * field whose value looks like a credential, the monitor treats the row as a
 * parse error and redacts the field in any persisted metadata + log line.
 *
 * Recognised credential shapes (high-precision; intentionally not exhaustive):
 *   - JWT triple-segment: `xxx.yyy.zzz` made of base64url chars
 *   - E2B / generic key prefix: `e2b_` followed by ≥16 [A-Za-z0-9_-] chars
 *   - Bearer prefix: `Bearer ` followed by ≥16 non-space chars
 *   - Generic 32+ char base64url tokens (length floor avoids false positives)
 */

export const REDACTED_VENDOR_VALUE = "***REDACTED***";

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/;
const E2B_KEY_RE = /^e2b_[A-Za-z0-9_-]{16,}$/i;
const BEARER_RE = /^Bearer\s+\S{16,}$/i;
const GENERIC_LONG_TOKEN_RE = /^[A-Za-z0-9_-]{32,}$/;

const KEY_HINTS_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;

export function looksLikeCredentialValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.length < 16) return false;
  if (JWT_RE.test(value)) return true;
  if (E2B_KEY_RE.test(value)) return true;
  if (BEARER_RE.test(value)) return true;
  if (GENERIC_LONG_TOKEN_RE.test(value)) return true;
  return false;
}

export function isCredentialShapedKey(key: string): boolean {
  return KEY_HINTS_RE.test(key);
}

export interface RedactedVendorResponse<T> {
  /** The original payload with any credential-shaped values replaced. */
  value: T;
  /**
   * `true` iff at least one field was redacted. The monitor escalates this to
   * a parse error so the row is NEVER persisted with a raw secret in it.
   */
  redactedAny: boolean;
  /** Dot-joined paths of redacted fields, for log-side observability. */
  redactedPaths: string[];
}

export function redactCredentialShapedValues<T>(input: T): RedactedVendorResponse<T> {
  const paths: string[] = [];
  const walk = (node: unknown, path: string): unknown => {
    if (node === null || node === undefined) return node;
    if (Array.isArray(node)) {
      return node.map((item, idx) => walk(item, `${path}[${idx}]`));
    }
    if (typeof node !== "object") {
      if (looksLikeCredentialValue(node)) {
        paths.push(path);
        return REDACTED_VENDOR_VALUE;
      }
      return node;
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (isCredentialShapedKey(key) && value !== null && value !== undefined) {
        // Explicitly named secret-shaped key always redacts, regardless of value shape.
        paths.push(childPath);
        out[key] = REDACTED_VENDOR_VALUE;
        continue;
      }
      out[key] = walk(value, childPath);
    }
    return out;
  };
  const value = walk(input, "") as T;
  return { value, redactedAny: paths.length > 0, redactedPaths: paths };
}
