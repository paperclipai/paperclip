import type {
  PluginRepositoryConnectionSnapshot,
  PluginRepositoryProviderBaseParams,
} from "@paperclipai/plugin-sdk";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import type { RepositoryConnection, PluginRepositoryProviderDeclaration } from "@paperclipai/shared";
import { normalizeRepositoryProviderHost } from "@paperclipai/shared";
import { unprocessable } from "../../errors.js";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import { sanitizeRepositoryProviderMetadata } from "../repository-normalization.js";
import { guardRepositoryProviderConnector } from "./connector-guard.js";
import type {
  BeginInstallationInput,
  CompleteInstallationInput,
  DiscoverInput,
  DiscoveredRepository,
  ProviderRepositorySnapshot,
  RefreshMetadataInput,
  RepositoryProviderConnector,
  ResolveCloneCredentialInput,
} from "./provider-contract.js";

/**
 * Bridges a plugin worker into the host's {@link RepositoryProviderConnector}
 * contract, so a trusted extension package can serve a first-class repository
 * provider without any of its code running in the server process.
 *
 * The bridge is deliberately thin and paranoid:
 *
 * - **Deny by default.** It is only built for a manifest-declared identity on a
 *   plugin that holds `repository.providers.register`, and every call re-checks
 *   that the worker is still running. A stopped, crashed, or unloaded plugin
 *   fails closed instead of hanging or half-answering.
 * - **Company scoped.** Each RPC carries the company the host resolved, and a
 *   connection belonging to another company or host is refused before dispatch.
 * - **No secrets cross the boundary.** The worker receives a sanitized
 *   connection snapshot — never a token, key, or raw row — and everything it
 *   returns passes through {@link guardRepositoryProviderConnector}.
 */

/** Worker-manager surface the bridge needs; narrow for easy testing. */
export type RepositoryProviderWorkerHost = Pick<PluginWorkerManager, "call" | "isRunning"> & {
  getWorker?: PluginWorkerManager["getWorker"];
};

/**
 * The hooks a worker must implement before the host will treat it as a
 * repository provider. A connector that answers installation but not credential
 * resolution would strand an operator halfway through connecting a repository,
 * so the seam refuses the registration instead.
 */
export const REQUIRED_REPOSITORY_PROVIDER_METHODS = [
  "repositoryProviderBeginInstallation",
  "repositoryProviderCompleteInstallation",
  "repositoryProviderDiscover",
  "repositoryProviderRefreshMetadata",
  "repositoryProviderSync",
  "repositoryProviderResolveCloneCredential",
] as const;

/**
 * Hooks a repository provider may leave unimplemented. Disconnect is advisory —
 * it lets a provider revoke an installation on its side — so a provider that has
 * nothing to revoke is allowed to omit it, and the host still tears the
 * connection down locally.
 */
export const OPTIONAL_REPOSITORY_PROVIDER_METHODS = ["repositoryProviderDisconnect"] as const;

/**
 * Methods a running worker declared at initialization but does not implement.
 * Returns an empty list when the worker manager cannot report them, since an
 * older worker handle predates the advertisement and is checked at call time.
 */
export function missingRepositoryProviderMethods(
  workerManager: RepositoryProviderWorkerHost,
  pluginId: string,
): string[] {
  const supported = workerManager.getWorker?.(pluginId)?.supportedMethods;
  if (!supported) return [];
  return REQUIRED_REPOSITORY_PROVIDER_METHODS.filter((method) => !supported.includes(method));
}

/**
 * Whether a worker advertises an optional method.
 *
 * A worker that reports no method list at all predates the advertisement, so it
 * is given the benefit of the doubt and the call is attempted — a worker that
 * turns out not to implement it answers `METHOD_NOT_IMPLEMENTED`, which the
 * caller treats as "nothing to do".
 */
function workerAdvertisesMethod(
  workerManager: RepositoryProviderWorkerHost,
  pluginId: string,
  method: string,
): boolean {
  const supported = workerManager.getWorker?.(pluginId)?.supportedMethods;
  if (!supported) return true;
  return supported.includes(method);
}

/** True when an RPC failure means "the worker does not implement this method". */
function isMethodNotImplemented(error: unknown): boolean {
  return error instanceof JsonRpcCallError && error.code === PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED;
}

export interface PluginRepositoryProviderConnectorOptions {
  pluginId: string;
  pluginKey: string;
  declaration: PluginRepositoryProviderDeclaration;
  workerManager: RepositoryProviderWorkerHost;
  /** RPC timeout for provider calls. Provider APIs are remote and can be slow. */
  timeoutMs?: number;
}

const DEFAULT_PROVIDER_RPC_TIMEOUT_MS = 30_000;

function toSnapshot(connection: RepositoryConnection): PluginRepositoryConnectionSnapshot {
  return {
    id: connection.id,
    companyId: connection.companyId,
    provider: connection.provider,
    host: connection.host,
    installationId: connection.installationId ?? null,
    accountId: connection.accountId ?? null,
    accountName: connection.accountName ?? null,
    status: connection.status,
    syncStatus: connection.syncStatus,
    syncCursor: connection.syncCursor ?? null,
    lastSyncedAt: connection.lastSyncedAt ? connection.lastSyncedAt.toISOString() : null,
    providerMetadata: sanitizeRepositoryProviderMetadata(connection.providerMetadata),
  };
}

function parseDate(value: unknown, field: string): Date {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) {
    throw unprocessable(`Repository provider returned an invalid ${field}`);
  }
  return date;
}

export function createPluginRepositoryProviderConnector(
  options: PluginRepositoryProviderConnectorOptions,
): RepositoryProviderConnector {
  const provider = options.declaration.providerKey.toLowerCase();
  const host = normalizeRepositoryProviderHost(options.declaration.host);
  if (!host) {
    throw new Error(
      `Plugin '${options.pluginKey}' declared repository provider host '${options.declaration.host}', which is not a valid identity`,
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_RPC_TIMEOUT_MS;

  function baseParams(companyId: string): PluginRepositoryProviderBaseParams {
    if (!options.workerManager.isRunning(options.pluginId)) {
      throw unprocessable(
        `Repository provider '${provider}' is unavailable because plugin '${options.pluginKey}' is not running`,
      );
    }
    if (!companyId) {
      throw unprocessable(`Repository provider '${provider}' requires a company scope`);
    }
    return { providerKey: provider, host: host!, companyId };
  }

  /**
   * A connection row is only served by the connector registered for its exact
   * identity. Without this a provider key registered for two hosts could be
   * handed another install's connection and mint credentials against it.
   */
  function assertOwnedConnection(connection: RepositoryConnection) {
    if (connection.provider.toLowerCase() !== provider) {
      throw unprocessable(`Repository connection is not served by provider '${provider}'`);
    }
    if (normalizeRepositoryProviderHost(connection.host) !== host) {
      throw unprocessable(`Repository connection host is outside provider '${provider}' registered identity`);
    }
  }

  const bridge: RepositoryProviderConnector = {
    provider,
    host,

    async beginInstallation(input: BeginInstallationInput) {
      const result = await options.workerManager.call(
        options.pluginId,
        "repositoryProviderBeginInstallation",
        {
          ...baseParams(input.companyId),
          userId: input.userId,
          redirectPath: input.redirectPath ?? null,
        },
        timeoutMs,
      );
      return {
        installUrl: String(result?.installUrl ?? ""),
        state: String(result?.state ?? ""),
        expiresAt: parseDate(result?.expiresAt, "installation state expiry"),
      };
    },

    async completeInstallation(input: CompleteInstallationInput) {
      const result = await options.workerManager.call(
        options.pluginId,
        "repositoryProviderCompleteInstallation",
        {
          ...baseParams(input.companyId),
          state: input.state,
          installationId: input.installationId,
        },
        timeoutMs,
      );
      return {
        companyId: String(result?.companyId ?? ""),
        userId: String(result?.userId ?? ""),
        installationId: String(result?.installationId ?? ""),
        accountId: result?.accountId ?? null,
        accountName: result?.accountName ?? null,
        host: String(result?.host ?? ""),
        providerMetadata: result?.providerMetadata ?? null,
      };
    },

    async discover(input: DiscoverInput) {
      assertOwnedConnection(input.connection);
      const result = await options.workerManager.call(
        options.pluginId,
        "repositoryProviderDiscover",
        {
          ...baseParams(input.connection.companyId),
          connection: toSnapshot(input.connection),
          query: input.query ?? null,
          cursor: input.cursor ?? null,
          pageSize: input.pageSize,
        },
        timeoutMs,
      );
      // Shapes are only asserted here; the guard wrapper does the validating.
      return {
        items: (Array.isArray(result?.items) ? result.items : []) as unknown as DiscoveredRepository[],
        nextCursor: result?.nextCursor ?? null,
        total: result?.total ?? null,
      };
    },

    async refreshMetadata(input: RefreshMetadataInput) {
      assertOwnedConnection(input.connection);
      const result = await options.workerManager.call(
        options.pluginId,
        "repositoryProviderRefreshMetadata",
        {
          ...baseParams(input.connection.companyId),
          connection: toSnapshot(input.connection),
          providerRepositoryId: input.providerRepositoryId,
        },
        timeoutMs,
      );
      return (result?.repository ?? null) as unknown as ProviderRepositorySnapshot | null;
    },

    async sync(input) {
      assertOwnedConnection(input.connection);
      const result = await options.workerManager.call(
        options.pluginId,
        "repositoryProviderSync",
        {
          ...baseParams(input.connection.companyId),
          connection: toSnapshot(input.connection),
          cursor: input.cursor,
        },
        timeoutMs,
      );
      return {
        repositories: (Array.isArray(result?.repositories)
          ? result.repositories
          : []) as unknown as ProviderRepositorySnapshot[],
        cursor: result?.cursor ?? null,
      };
    },

    /**
     * Disconnect is optional for a provider. When the worker does not advertise
     * the hook — or answers `METHOD_NOT_IMPLEMENTED` because it predates the
     * advertisement — the host still tears the connection down locally instead
     * of failing the disconnect and stranding the connection in `error`.
     */
    async disconnect(input) {
      assertOwnedConnection(input.connection);
      if (!workerAdvertisesMethod(options.workerManager, options.pluginId, "repositoryProviderDisconnect")) {
        return;
      }
      try {
        await options.workerManager.call(
          options.pluginId,
          "repositoryProviderDisconnect",
          {
            ...baseParams(input.connection.companyId),
            connection: toSnapshot(input.connection),
          },
          timeoutMs,
        );
      } catch (error) {
        if (!isMethodNotImplemented(error)) throw error;
      }
    },

    async resolveCloneCredential(input: ResolveCloneCredentialInput) {
      assertOwnedConnection(input.connection);
      const result = await options.workerManager.call(
        options.pluginId,
        "repositoryProviderResolveCloneCredential",
        {
          ...baseParams(input.connection.companyId),
          connection: toSnapshot(input.connection),
          repository: {
            id: input.repository.id,
            providerRepositoryId: input.repository.providerRepositoryId,
            owner: input.repository.owner,
            name: input.repository.name,
            cloneUrl: input.repository.cloneUrl,
            host: input.repository.host,
          },
        },
        timeoutMs,
      );
      const expiresAt = parseDate(result?.expiresAt, "clone credential expiry");
      return {
        username: String(result?.username ?? ""),
        token: String(result?.token ?? ""),
        authenticatedCloneUrl: String(result?.authenticatedCloneUrl ?? ""),
        expiresAt,
        audit: {
          provider,
          host: host!,
          connectionId: input.connection.id,
          repositoryId: input.repository.id,
          installationId: result?.audit?.installationId ?? input.connection.installationId,
          expiresAt,
        },
      };
    },
  };

  return guardRepositoryProviderConnector(bridge, { provider, host });
}
