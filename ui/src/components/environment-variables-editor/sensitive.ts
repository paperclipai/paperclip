/**
 * Sensitive-value detection (plan §6.6). Kept in sync with the server-side
 * migration heuristic so the UI flags the same things the backend would.
 * Source of the key regex: `scripts/migrate-inline-env-secrets.ts:5`.
 */

/** Env-var NAMES that conventionally hold credentials. */
export const SENSITIVE_ENV_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;

/** Well-known credential value shapes (provider token prefixes, PEM headers). */
const CREDENTIAL_VALUE_RES: RegExp[] = [
  /^sk-[A-Za-z0-9-_]{16,}$/, // OpenAI / Stripe style
  /^gh[pousr]_[A-Za-z0-9]{20,}$/, // GitHub PAT / OAuth / server / refresh
  /^github_pat_[A-Za-z0-9_]{20,}$/, // GitHub fine-grained PAT
  /^xox[baprs]-[A-Za-z0-9-]{10,}$/, // Slack tokens
  /^AKIA[0-9A-Z]{16}$/, // AWS access key id
  /^AIza[0-9A-Za-z\-_]{20,}$/, // Google API key
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/, // PEM private key
  /^eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/, // JWT
];

function looksHighEntropy(value: string): boolean {
  // A long, unbroken, mixed token (base64/hex/opaque secret) with no spaces.
  if (value.length < 24) return false;
  if (/\s/.test(value)) return false;
  if (!/^[A-Za-z0-9+/=_\-.]+$/.test(value)) return false;
  const hasLower = /[a-z]/.test(value);
  const hasUpper = /[A-Z]/.test(value);
  const hasDigit = /[0-9]/.test(value);
  // Require at least two character classes so plain lowercase words/paths
  // (e.g. a long file path) don't trip the heuristic.
  const classes = [hasLower, hasUpper, hasDigit].filter(Boolean).length;
  return classes >= 2;
}

/**
 * Returns true when a Text-source binding looks like it holds a secret and
 * should be surfaced with the "Store as secret" suggestion.
 */
export function isSensitiveEnv(name: string, value: string): boolean {
  if (!value) return false;
  if (SENSITIVE_ENV_KEY_RE.test(name)) return true;
  if (CREDENTIAL_VALUE_RES.some((re) => re.test(value))) return true;
  return looksHighEntropy(value);
}
