import { githubAppJwt } from "../../chat-github-client.js";

import { discoverDedicatedGitHubAppInstallation, listGitHubInstallationRepositories } from "../../chat-provider-inventory.js";

import type { PreparedProviderInventory } from "../runtime-types.js";

export async function prepareGitHubInventory(credentials: Record<string,string>, fetchImpl: typeof fetch): Promise<PreparedProviderInventory> {
  const appJwt = githubAppJwt(credentials.appId, credentials.privateKey);
  const installation = await discoverDedicatedGitHubAppInstallation({
    appJwt,
    fetch: fetchImpl,
  });
  const preparedCredentials = {
    ...credentials,
    installationId: installation.installationId,
  };
  const inventory = await listGitHubInstallationRepositories({
    appJwt,
    installationId: installation.installationId,
    fetch: fetchImpl,
  });
  return {
    credentials: preparedCredentials,
    managementUrl: installation.accountType === "Organization" && installation.accountLabel
      ? `https://github.com/organizations/${encodeURIComponent(installation.accountLabel)}/settings/installations/${installation.installationId}`
      : `https://github.com/settings/installations/${installation.installationId}`,
    inventory: {
      ...inventory,
      resources: inventory.resources.map((resource) => {
        const fullName =
          typeof resource.metadata?.fullName === "string"
            ? resource.metadata.fullName
            : resource.label.includes("/")
              ? resource.label
              : null;
        return fullName
          ? {
              ...resource,
              providerResourceId: fullName.toLowerCase(),
              metadata: {
                ...resource.metadata,
                providerRepositoryId: resource.providerResourceId,
                fullName,
              },
            }
          : resource;
      }),
    },
  };
}
