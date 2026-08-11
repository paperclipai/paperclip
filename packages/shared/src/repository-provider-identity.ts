/**
 * Canonical identity for a repository provider connector.
 *
 * A connector is identified by its provider key **plus** its normalized host,
 * so `github` on `github.com` and `github` on `github.acme-corp.com` are two
 * distinct registrations that can never shadow each other. This module is the
 * single normalization source shared by the plugin manifest validator, the
 * host-side connector registry, and any extension package that needs to
 * compute the same key.
 *
 * Pure and dependency-free on purpose: it is imported by `@paperclipai/shared`
 * consumers, by the server registry, and by trusted extension packages.
 */

/** Wildcard host used when a connector serves any host for its provider. */
export const REPOSITORY_PROVIDER_ANY_HOST = "*";

const PROVIDER_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Normalizes a provider key to its canonical lowercase form.
 * Returns `null` when the value is not a usable provider key.
 */
export function normalizeRepositoryProviderKey(rawProvider: unknown): string | null {
  if (typeof rawProvider !== "string") return null;
  const provider = rawProvider.trim().toLowerCase();
  if (!provider || provider.length > 64) return null;
  return PROVIDER_KEY_PATTERN.test(provider) ? provider : null;
}

/**
 * Normalizes a provider host to a bare lowercase `host[:port]`.
 *
 * Rejects anything carrying credentials, a path, a query, or a fragment — a
 * host that smuggles those is a redirect/SSRF vector, and it would also make
 * connector identity ambiguous. Returns `null` instead of throwing so callers
 * (manifest validation, untrusted worker output) decide their own failure mode.
 */
export function normalizeRepositoryProviderHost(rawHost: unknown): string | null {
  if (typeof rawHost !== "string") return null;
  const trimmed = rawHost.trim();
  if (!trimmed || trimmed.length > 255) return null;
  if (trimmed === REPOSITORY_PROVIDER_ANY_HOST) return REPOSITORY_PROVIDER_ANY_HOST;

  let parsed: URL;
  try {
    parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (parsed.pathname && parsed.pathname !== "/") return null;
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const host = parsed.host.toLowerCase();
  return host || null;
}

/**
 * Builds the canonical registry key for a connector identity.
 * Callers must pass already-normalized values; use the normalizers above.
 */
export function repositoryProviderIdentityKey(input: {
  provider: string;
  host: string;
  companyId?: string | null;
}): string {
  const scope = input.companyId ? `company:${input.companyId}` : "instance";
  return `${scope}|${input.provider}|${input.host}`;
}
