import {
  repositoryProviderRegistry,
  type RepositoryProviderDescriptor,
  type RepositoryProviderLookup,
} from "../repository-connections.js";
import type { RepositoryProviderConnector } from "./provider-contract.js";

/**
 * Narrows a registered Foundation adapter to the full connection/discovery
 * {@link RepositoryProviderConnector}. Providers registered by the GitHub.com
 * path implement the extended surface; a bare Foundation adapter (sync-only)
 * does not and is treated as "discovery not supported".
 */
export function isProviderConnector(value: unknown): value is RepositoryProviderConnector {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RepositoryProviderConnector>;
  return (
    typeof candidate.beginInstallation === "function" &&
    typeof candidate.completeInstallation === "function" &&
    typeof candidate.discover === "function" &&
    typeof candidate.refreshMetadata === "function" &&
    typeof candidate.resolveCloneCredential === "function"
  );
}

/**
 * Resolves the connector for a provider identity.
 *
 * Pass `lookup.host` (and `lookup.companyId` where known) so the right
 * connector answers when several hosts serve the same provider key — the
 * github.com connector must never answer for an enterprise host, and vice
 * versa. Omitting the host only resolves when the identity is unambiguous.
 */
export function getRepositoryProviderConnector(
  provider: string,
  lookup: RepositoryProviderLookup = {},
  registry: Pick<typeof repositoryProviderRegistry, "get"> = repositoryProviderRegistry,
): RepositoryProviderConnector | null {
  const adapter = registry.get(provider, lookup);
  return isProviderConnector(adapter) ? adapter : null;
}

/** One connectable provider identity as presented to core UI. */
export interface RepositoryProviderAvailability extends RepositoryProviderDescriptor {
  provider: string;
  host: string;
}

/**
 * Providers a company can currently connect.
 *
 * Availability is derived from live registrations, never from what a manifest
 * claims: an extension whose worker is stopped or unloaded disappears from this
 * list, so core UI stops offering a provider the host could not actually serve.
 */
export function listAvailableRepositoryProviders(
  companyId: string,
  registry: Pick<typeof repositoryProviderRegistry, "list"> = repositoryProviderRegistry,
): RepositoryProviderAvailability[] {
  return registry
    .list({ companyId })
    .map((registration) => ({
      provider: registration.provider,
      host: registration.host,
      ...registration.descriptor,
      // Discovery is only real when the adapter implements the extended
      // connector surface, whatever the declaration claims.
      supportsDiscovery: registration.descriptor.supportsDiscovery && isProviderConnector(registration.adapter),
    }))
    .sort((a, b) => (a.provider === b.provider ? a.host.localeCompare(b.host) : a.provider.localeCompare(b.provider)));
}
