import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RepositoryConnection } from "@paperclipai/shared";
import type { HostToWorkerMethodName } from "@paperclipai/plugin-sdk";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { FakeRepositoryProvider } from "../services/repository-providers/fake-provider.js";
import {
  createPluginRepositoryProviderConnector,
  REQUIRED_REPOSITORY_PROVIDER_METHODS,
} from "../services/repository-providers/plugin-connector.js";
import {
  runProviderConformance,
  type ProviderConformanceWorld,
} from "./helpers/fake-github-transport.js";

/**
 * Parity check for the extension seam: the exact conformance suite the
 * in-process GitHub.com provider passes is run against a provider reached over
 * the plugin worker RPCs. If the wire contract loses a guarantee — a dropped
 * cursor, a Date that never round-trips, an error that stops rejecting — this
 * fails, so an EE package cannot be blocked by a seam that only looks complete.
 *
 * The fake "worker" marshals the wire payloads to the in-memory reference
 * provider, standing in for a real extension's `onRepositoryProvider*` hooks.
 */

const HOST = "github.acme-corp.example";
const PROVIDER = "github-enterprise";

function connectionFromSnapshot(snapshot: {
  id: string;
  companyId: string;
  provider: string;
  host: string;
  installationId: string | null;
  accountId: string | null;
  accountName: string | null;
  syncCursor: string | null;
  providerMetadata: Record<string, unknown> | null;
}): RepositoryConnection {
  const now = new Date();
  return {
    id: snapshot.id,
    companyId: snapshot.companyId,
    provider: snapshot.provider,
    host: snapshot.host,
    installationId: snapshot.installationId,
    accountId: snapshot.accountId,
    accountName: snapshot.accountName,
    status: "active",
    syncStatus: "idle",
    syncCursor: snapshot.syncCursor,
    syncError: null,
    lastSyncedAt: null,
    providerMetadata: snapshot.providerMetadata,
    disconnectedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function bridgedWorld(): ProviderConformanceWorld {
  const provider = new FakeRepositoryProvider({ provider: PROVIDER, host: HOST, pageSize: 2 });
  const reference = provider.connector();
  const companyId = randomUUID();
  const userId = randomUUID();
  const installationId = `install-${randomUUID().slice(0, 8)}`;
  const accountName = "acme";

  provider.setInstallation({ installationId, accountId: "account-1", accountName, repositories: [] });

  // Stands in for a plugin worker: JSON-shaped params in, JSON-shaped results
  // out, with every Date crossing the boundary as an ISO-8601 string.
  const workerManager = {
    isRunning: () => true,
    call: (async (_pluginId: string, method: HostToWorkerMethodName, params: never) => {
      const input = params as Record<string, never>;
      switch (method) {
        case "repositoryProviderBeginInstallation": {
          const result = await reference.beginInstallation({
            companyId: input.companyId,
            userId: input.userId,
            redirectPath: input.redirectPath ?? null,
          });
          return { ...result, expiresAt: result.expiresAt.toISOString() };
        }
        case "repositoryProviderCompleteInstallation":
          return await reference.completeInstallation({
            state: input.state,
            installationId: input.installationId,
            companyId: input.companyId,
          });
        case "repositoryProviderDiscover":
          return await reference.discover({
            connection: connectionFromSnapshot(input.connection),
            query: input.query ?? null,
            cursor: input.cursor ?? null,
            pageSize: input.pageSize,
          });
        case "repositoryProviderRefreshMetadata":
          return {
            repository: await reference.refreshMetadata({
              connection: connectionFromSnapshot(input.connection),
              providerRepositoryId: input.providerRepositoryId,
            }),
          };
        case "repositoryProviderSync":
          return await reference.sync({
            connection: connectionFromSnapshot(input.connection),
            cursor: input.cursor ?? null,
          });
        case "repositoryProviderDisconnect":
          await reference.disconnect?.({ connection: connectionFromSnapshot(input.connection) });
          return undefined;
        case "repositoryProviderResolveCloneCredential": {
          const result = await reference.resolveCloneCredential({
            connection: connectionFromSnapshot(input.connection),
            repository: input.repository,
          });
          return {
            username: result.username,
            token: result.token,
            authenticatedCloneUrl: result.authenticatedCloneUrl,
            expiresAt: result.expiresAt.toISOString(),
            audit: { installationId: result.audit.installationId },
          };
        }
        default:
          throw new Error(`unexpected worker method ${method}`);
      }
    }) as never,
  };

  const connector = createPluginRepositoryProviderConnector({
    pluginId: randomUUID(),
    pluginKey: "acme.github-enterprise",
    declaration: { providerKey: PROVIDER, displayName: "GitHub Enterprise", host: HOST },
    workerManager,
  });

  return {
    connector,
    companyId,
    userId,
    installationId,
    accountName,
    seed(repos) {
      provider.setInstallation({
        installationId,
        accountId: "account-1",
        accountName,
        repositories: repos.map((repo) => ({ ...repo })),
      });
    },
    rename(providerRepositoryId, next) {
      provider.rename(installationId, providerRepositoryId, next);
    },
  };
}

describe("plugin-bridged repository provider conformance", () => {
  runProviderConformance(bridgedWorld);
});

/**
 * Disconnect is the one provider hook a plugin may leave out — a provider with
 * nothing to revoke on its side has no work to do. The host must still tear the
 * connection down locally. Dispatching the RPC anyway makes the worker answer
 * `METHOD_NOT_IMPLEMENTED`, which would strand the connection in `error` and
 * leave an operator unable to disconnect at all.
 */
describe("plugin-bridged optional disconnect", () => {
  const connection = connectionFromSnapshot({
    id: randomUUID(),
    companyId: randomUUID(),
    provider: PROVIDER,
    host: HOST,
    installationId: "install-1",
    accountId: "account-1",
    accountName: "acme",
    syncCursor: null,
    providerMetadata: null,
  });

  function connectorWith(worker: { supportedMethods?: string[]; call: () => Promise<unknown> }) {
    const calls: string[] = [];
    const connector = createPluginRepositoryProviderConnector({
      pluginId: randomUUID(),
      pluginKey: "acme.github-enterprise",
      declaration: { providerKey: PROVIDER, displayName: "GitHub Enterprise", host: HOST },
      workerManager: {
        isRunning: () => true,
        getWorker: ((() =>
          worker.supportedMethods ? { supportedMethods: worker.supportedMethods } : undefined) as never),
        call: (async (_pluginId: string, method: HostToWorkerMethodName) => {
          calls.push(method);
          return await worker.call();
        }) as never,
      },
    });
    return { connector, calls };
  }

  it("does not dispatch when the worker does not advertise the hook", async () => {
    const { connector, calls } = connectorWith({
      supportedMethods: [...REQUIRED_REPOSITORY_PROVIDER_METHODS],
      call: async () => {
        throw new Error("must not dispatch");
      },
    });

    await expect(connector.disconnect!({ connection })).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("tolerates METHOD_NOT_IMPLEMENTED from a worker that advertises nothing", async () => {
    const { connector, calls } = connectorWith({
      call: async () => {
        throw new JsonRpcCallError({
          code: PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED,
          message: "repositoryProviderDisconnect is not implemented",
        });
      },
    });

    await expect(connector.disconnect!({ connection })).resolves.toBeUndefined();
    expect(calls).toEqual(["repositoryProviderDisconnect"]);
  });

  it("dispatches when the worker advertises the hook", async () => {
    const { connector, calls } = connectorWith({
      supportedMethods: [...REQUIRED_REPOSITORY_PROVIDER_METHODS, "repositoryProviderDisconnect"],
      call: async () => undefined,
    });

    await connector.disconnect!({ connection });
    expect(calls).toEqual(["repositoryProviderDisconnect"]);
  });

  it("still surfaces a real provider failure", async () => {
    const { connector } = connectorWith({
      supportedMethods: [...REQUIRED_REPOSITORY_PROVIDER_METHODS, "repositoryProviderDisconnect"],
      call: async () => {
        throw new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE, message: "worker crashed" });
      },
    });

    await expect(connector.disconnect!({ connection })).rejects.toThrow("worker crashed");
  });
});
