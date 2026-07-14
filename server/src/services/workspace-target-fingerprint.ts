import { createHmac } from "node:crypto";

/**
 * Derives the versioned keyed-hash fingerprint used to identify a workspace
 * target (repository, remote path, etc.) without exposing the underlying
 * locator. See doc/execution-semantics.md, "Privacy-safe fingerprints":
 *
 *   v1:hmac-sha256(instance_attestation_key, companyId + "\n" + providerKey + "\n" + canonicalLocator)
 *
 * The key is derived from the shared agent JWT master secret, domain-separated
 * with a "workspace-target-fingerprint:" prefix so it cannot be confused with
 * or reused as the JWT signing key (see agent-auth-jwt.ts for the same pattern).
 */
export function computeTargetFingerprint(companyId: string, providerKey: string, canonicalLocator: string): string {
  const masterSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim();
  if (!masterSecret) {
    throw new Error("Cannot compute workspace target fingerprint: no signing secret configured");
  }
  const instanceKey = createHmac("sha256", masterSecret).update("workspace-target-fingerprint:v1").digest();
  const digest = createHmac("sha256", instanceKey)
    .update(`${companyId}\n${providerKey}\n${canonicalLocator}`)
    .digest("hex");
  return `v1:${digest}`;
}

/**
 * Canonicalizes a repository/remote locator before fingerprinting: strips
 * credentials, userinfo, query parameters, and fragments so the fingerprint
 * never depends on (or leaks) secret-bearing parts of the locator.
 */
export function canonicalizeRepositoryLocator(rawLocator: string): string {
  const trimmed = rawLocator.trim();
  try {
    const url = new URL(trimmed);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    // Not a URL (e.g. an scp-style git remote or bare path) — strip any
    // userinfo-like "user@" prefix and trailing slashes, lowercase for stability.
    return trimmed.replace(/^[^@/\s]+@/, "").replace(/\/+$/, "").toLowerCase();
  }
}
