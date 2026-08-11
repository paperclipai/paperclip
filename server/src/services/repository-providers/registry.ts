import { repositoryProviderRegistry } from "../repository-connections.js";
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

export function getRepositoryProviderConnector(
  provider: string,
  registry: Pick<typeof repositoryProviderRegistry, "get"> = repositoryProviderRegistry,
): RepositoryProviderConnector | null {
  const adapter = registry.get(provider);
  return isProviderConnector(adapter) ? adapter : null;
}
