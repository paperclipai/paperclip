import type { ProjectRepositoryOptions } from "@paperclipai/shared";

export type RepositoryCatalogProvider = {
  id: string;
  list: () => Promise<ProjectRepositoryOptions>;
};

export async function listRegisteredRepositoryProviders(providers: readonly RepositoryCatalogProvider[]): Promise<ProjectRepositoryOptions> {
  const results = await Promise.all(providers.map((provider) => provider.list()));
  return {
    repositories: results.flatMap((result) => result.repositories).sort((a, b) => a.fullName.localeCompare(b.fullName)),
    connections: results.flatMap((result) => result.connections ?? []),
    connectionCount: results.reduce((total, result) => total + result.connectionCount, 0),
    failedConnectionCount: results.reduce((total, result) => total + result.failedConnectionCount, 0),
  };
}
