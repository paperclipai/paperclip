import { REDACTED_EVENT_VALUE } from "./redaction.js";

/**
 * Pattern-based redaction guesses at credential shape, so it lags every new vendor
 * prefix (this is how cleartext `github_pat_` values reached run logs while classic
 * `ghp_` values were caught). At dispatch time the runtime already holds the resolved
 * plaintext of every secret it bound into the adapter environment, so those values can
 * be redacted by identity instead of by shape.
 */

/**
 * Values shorter than this are skipped: a short bound value such as `1` or `true`
 * would otherwise blank unrelated output everywhere it happened to appear.
 */
export const MIN_REDACTABLE_SECRET_LENGTH = 12;

const SECRET_ENV_KEY_RE =
  /(api[-_]?key|github[-_]?pat|access[-_]?token|auth(?:[-_]?token)?|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;

/**
 * True when an env key name alone is enough to treat its value as a credential,
 * independent of whether it was bound through a secret ref.
 */
export function isSecretEnvKey(key: string): boolean {
  return SECRET_ENV_KEY_RE.test(key);
}

/**
 * Select the plaintext values worth redacting by identity from a resolved adapter
 * environment. `secretKeys` are the env keys whose values came from resolved secret
 * refs; credential-named keys are included as well so a plainly-configured token is
 * covered too.
 */
export function collectRunSecretValues(
  env: Record<string, unknown>,
  secretKeys: Iterable<string> = [],
): string[] {
  const secretKeySet = new Set(secretKeys);
  const values: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (!secretKeySet.has(key) && !isSecretEnvKey(key)) continue;
    values.push(value);
  }
  return values;
}

/**
 * Deduplicate and order candidate values longest-first so that when one secret
 * contains another, the longer match is replaced before the shorter one and no
 * partial secret survives in the output.
 */
export function orderRedactableSecretValues(values: Iterable<string>): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed.length < MIN_REDACTABLE_SECRET_LENGTH) continue;
    unique.add(trimmed);
  }
  return [...unique].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

export type SecretValueRedactor = (text: string) => string;

/**
 * Build a redactor that replaces every known secret plaintext with `redactedValue`.
 * Returns an identity function when nothing qualifies, so the hot log path pays
 * nothing on runs that bound no secrets.
 */
export function createSecretValueRedactor(
  values: Iterable<string>,
  redactedValue: string = REDACTED_EVENT_VALUE,
): SecretValueRedactor {
  const ordered = orderRedactableSecretValues(values);
  if (ordered.length === 0) return (text: string) => text;
  return (text: string) => {
    if (!text) return text;
    let result = text;
    for (const secret of ordered) {
      if (!result.includes(secret)) continue;
      result = result.split(secret).join(redactedValue);
    }
    return result;
  };
}
