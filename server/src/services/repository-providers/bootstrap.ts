import { repositoryProviderRegistry } from "../repository-connections.js";
import { guardRepositoryProviderConnector } from "./connector-guard.js";
import { createGitHubProvider } from "./github-provider.js";
import { createGitHubAppTransport } from "./github-transport.js";

/**
 * Registers repository providers configured via environment. Registration is a
 * no-op when the required config is absent, so a deployment without a GitHub App
 * simply exposes manual repositories. Secrets (app id, private key, state
 * secret) are read here and handed to the transport/provider; they are never
 * persisted on any row.
 */
export interface RegisterRepositoryProvidersOptions {
  env?: NodeJS.ProcessEnv;
}

export function registerConfiguredRepositoryProviders(
  options: RegisterRepositoryProvidersOptions = {},
): Array<() => void> {
  const env = options.env ?? process.env;
  const unregister: Array<() => void> = [];

  const appId = env.PAPERCLIP_GITHUB_APP_ID?.trim();
  const privateKey = env.PAPERCLIP_GITHUB_APP_PRIVATE_KEY;
  const appSlug = env.PAPERCLIP_GITHUB_APP_SLUG?.trim();
  const stateSecret = env.PAPERCLIP_GITHUB_CONNECTION_STATE_SECRET?.trim();

  if (appId && privateKey && appSlug && stateSecret) {
    const transport = createGitHubAppTransport({
      appId,
      privateKey,
      host: env.PAPERCLIP_GITHUB_HOST?.trim() || undefined,
      apiBaseUrl: env.PAPERCLIP_GITHUB_API_BASE_URL?.trim() || undefined,
    });
    const provider = createGitHubProvider({ transport, config: { appSlug, stateSecret } });
    unregister.push(repositoryProviderRegistry.register(
      // Core providers go through the same hardening wrapper as extensions:
      // one contract, one place where provider output is validated.
      guardRepositoryProviderConnector(provider, { provider: provider.provider, host: provider.host }),
      {
        host: provider.host,
        descriptor: {
          displayName: "GitHub",
          source: "core",
          supportsDiscovery: true,
          supportsCloneCredentials: true,
        },
      },
    ));
  }

  return unregister;
}
