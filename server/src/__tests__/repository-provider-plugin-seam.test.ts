import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1, RepositoryConnection } from "@paperclipai/shared";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import type { HostToWorkerMethodName, HostToWorkerMethods } from "@paperclipai/plugin-sdk";
import { pluginCapabilityValidator } from "../services/plugin-capability-validator.js";
import { repositoryProviderRegistry } from "../services/repository-connections.js";
import {
  authorizedRepositoryProviderDeclarations,
  createPluginRepositoryProviderRegistrar,
  pluginRepositoryProviderOwnerKey,
  type RepositoryProviderPluginRecord,
  type RepositoryProviderPluginSource,
} from "../services/repository-providers/plugin-registrar.js";
import {
  createPluginRepositoryProviderConnector,
  REQUIRED_REPOSITORY_PROVIDER_METHODS,
} from "../services/repository-providers/plugin-connector.js";
import { markCloneCredentialNoStore } from "../services/repository-providers/connector-guard.js";
import {
  getRepositoryProviderConnector,
  listAvailableRepositoryProviders,
} from "../services/repository-providers/registry.js";

/**
 * Regression coverage for the trusted-extension repository provider seam
 * (PAP-17075). These are the failure modes the seam exists to prevent:
 * unauthorized registration, registrations outliving their plugin, capability
 * claims that outrun what the host can actually serve, secrets escaping into
 * anything serializable, and a misbehaving extension being trusted.
 */

const HOST = "github.acme-corp.example";
const PROVIDER = "github-enterprise";
const PLUGIN_ID = "00000000-0000-4000-8000-00000000p1ug".replace("p1ug", "0001");
const PLUGIN_KEY = "acme.github-enterprise";

function manifest(overrides: Partial<PaperclipPluginManifestV1> = {}): PaperclipPluginManifestV1 {
  return {
    id: PLUGIN_KEY,
    apiVersion: 1,
    version: "1.0.0",
    displayName: "GitHub Enterprise",
    description: "Trusted EE repository provider",
    author: "Paperclip",
    categories: ["connector"],
    capabilities: ["repository.providers.register"],
    entrypoints: { worker: "dist/worker.js" },
    repositoryProviders: [{
      providerKey: PROVIDER,
      displayName: "GitHub Enterprise",
      host: HOST,
      supportsDiscovery: true,
      supportsCloneCredentials: true,
    }],
    ...overrides,
  } as PaperclipPluginManifestV1;
}

function pluginRecord(overrides: Partial<RepositoryProviderPluginRecord> = {}): RepositoryProviderPluginRecord {
  return {
    id: PLUGIN_ID,
    pluginKey: PLUGIN_KEY,
    status: "ready",
    manifestJson: manifest(),
    ...overrides,
  };
}

/** Minimal in-memory lifecycle emitter matching the manager's on/off surface. */
function fakeLifecycle() {
  const handlers = new Map<string, Set<(payload: never) => void>>();
  return {
    on(event: string, handler: (payload: never) => void) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    off(event: string, handler: (payload: never) => void) {
      handlers.get(event)?.delete(handler);
    },
    emit(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) (handler as (p: unknown) => void)(payload);
    },
  };
}

interface FakeWorkerOptions {
  running?: boolean;
  /** Methods the worker reported at initialization. Omit to skip the check. */
  supportedMethods?: string[];
  handlers?: Partial<{
    [M in HostToWorkerMethodName]: (params: HostToWorkerMethods[M][0]) => unknown;
  }>;
}

function fakeWorkerManager(options: FakeWorkerOptions = {}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  let running = options.running ?? true;
  return {
    calls,
    setRunning(next: boolean) {
      running = next;
    },
    isRunning: () => running,
    getWorker: ((() =>
      (options.supportedMethods
        ? { supportedMethods: options.supportedMethods }
        : undefined)) as never),
    call: (async (_pluginId: string, method: HostToWorkerMethodName, params: unknown) => {
      calls.push({ method, params });
      const handler = options.handlers?.[method] as ((p: unknown) => unknown) | undefined;
      if (!handler) throw new Error(`unexpected worker call: ${method}`);
      return await handler(params);
    }) as never,
  };
}

function connection(overrides: Partial<RepositoryConnection> = {}): RepositoryConnection {
  const now = new Date();
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    provider: PROVIDER,
    host: HOST,
    installationId: "install-1",
    accountId: "account-1",
    accountName: "acme",
    status: "active",
    syncStatus: "idle",
    syncCursor: null,
    syncError: null,
    lastSyncedAt: null,
    providerMetadata: null,
    disconnectedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function pluginSource(records: RepositoryProviderPluginRecord[]): RepositoryProviderPluginSource {
  return {
    getById: async (pluginId) => records.find((record) => record.id === pluginId) ?? null,
    listReady: async () => records.filter((record) => record.status === "ready"),
  };
}

beforeEach(() => {
  repositoryProviderRegistry.unregisterOwner(pluginRepositoryProviderOwnerKey(PLUGIN_ID));
});

describe("manifest authorization", () => {
  it("rejects a repositoryProviders manifest that omits the capability", () => {
    const withoutCapability = manifest({ capabilities: ["issues.read"] });

    const parsed = pluginManifestV1Schema.safeParse(withoutCapability);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("repository.providers.register");

    const validated = pluginCapabilityValidator().validateManifestCapabilities(withoutCapability);
    expect(validated.allowed).toBe(false);
    expect(validated.missing).toContain("repository.providers.register");
  });

  it("accepts a declaration that holds the capability and normalizes its host", () => {
    const parsed = pluginManifestV1Schema.safeParse(manifest({
      repositoryProviders: [{
        providerKey: "GitHub-Enterprise",
        displayName: "GitHub Enterprise",
        host: "HTTPS://GitHub.Acme-Corp.Example/",
      }],
    }));
    expect(parsed.success).toBe(true);
    expect(parsed.data?.repositoryProviders?.[0]).toMatchObject({
      providerKey: PROVIDER,
      host: HOST,
    });
  });

  it("rejects a host carrying a path, credentials, or a wildcard", () => {
    for (const host of ["github.example.com/enterprise", "user:pw@github.example.com", "*"]) {
      const parsed = pluginManifestV1Schema.safeParse(manifest({
        repositoryProviders: [{ providerKey: PROVIDER, displayName: "X", host }],
      }));
      expect(parsed.success, `host ${host} must be rejected`).toBe(false);
    }
  });

  it("rejects two declarations that collapse to the same connector identity", () => {
    const parsed = pluginManifestV1Schema.safeParse(manifest({
      repositoryProviders: [
        { providerKey: PROVIDER, displayName: "A", host: HOST },
        { providerKey: PROVIDER.toUpperCase(), displayName: "B", host: `HTTPS://${HOST}` },
      ],
    }));
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("Duplicate repositoryProviders identities");
  });

  it("authorizes nothing at all when the capability is missing", () => {
    expect(authorizedRepositoryProviderDeclarations(manifest({ capabilities: ["issues.read"] }))).toEqual([]);
    expect(authorizedRepositoryProviderDeclarations(manifest())).toHaveLength(1);
  });
});

describe("registration lifecycle", () => {
  it("does not register a plugin that lacks the capability", async () => {
    const lifecycle = fakeLifecycle();
    const registrar = createPluginRepositoryProviderRegistrar({
      lifecycle,
      workerManager: fakeWorkerManager(),
      plugins: pluginSource([pluginRecord({ manifestJson: manifest({ capabilities: ["issues.read"] }) })]),
    });
    await registrar.start();

    expect(getRepositoryProviderConnector(PROVIDER, { host: HOST })).toBeNull();
    registrar.stop();
  });

  it("does not register a plugin whose worker is not running", async () => {
    const lifecycle = fakeLifecycle();
    const registrar = createPluginRepositoryProviderRegistrar({
      lifecycle,
      workerManager: fakeWorkerManager({ running: false }),
      plugins: pluginSource([pluginRecord()]),
    });
    await registrar.start();

    expect(getRepositoryProviderConnector(PROVIDER, { host: HOST })).toBeNull();
    registrar.stop();
  });

  it("does not register a worker that implements only part of the connector", async () => {
    const lifecycle = fakeLifecycle();
    const registrar = createPluginRepositoryProviderRegistrar({
      lifecycle,
      workerManager: fakeWorkerManager({
        supportedMethods: [...REQUIRED_REPOSITORY_PROVIDER_METHODS].filter(
          (method) => method !== "repositoryProviderResolveCloneCredential",
        ),
      }),
      plugins: pluginSource([pluginRecord()]),
    });
    await registrar.start();

    expect(getRepositoryProviderConnector(PROVIDER, { host: HOST })).toBeNull();
    registrar.stop();
  });

  it("registers a worker that implements the whole connector", async () => {
    const lifecycle = fakeLifecycle();
    const registrar = createPluginRepositoryProviderRegistrar({
      lifecycle,
      workerManager: fakeWorkerManager({ supportedMethods: [...REQUIRED_REPOSITORY_PROVIDER_METHODS] }),
      plugins: pluginSource([pluginRecord()]),
    });
    await registrar.start();

    expect(getRepositoryProviderConnector(PROVIDER, { host: HOST })).not.toBeNull();
    registrar.stop();
  });

  it("does not register a plugin that is installed but not ready", async () => {
    const lifecycle = fakeLifecycle();
    const registrar = createPluginRepositoryProviderRegistrar({
      lifecycle,
      workerManager: fakeWorkerManager(),
      plugins: pluginSource([pluginRecord({ status: "disabled" })]),
    });
    await registrar.start();

    expect(getRepositoryProviderConnector(PROVIDER, { host: HOST })).toBeNull();
    registrar.stop();
  });

  it("registers on worker start and unregisters on stop, unload, and error", async () => {
    const lifecycle = fakeLifecycle();
    const workerManager = fakeWorkerManager({ running: false });
    const registrar = createPluginRepositoryProviderRegistrar({
      lifecycle,
      workerManager,
      plugins: pluginSource([pluginRecord()]),
    });
    await registrar.start();
    expect(getRepositoryProviderConnector(PROVIDER, { host: HOST })).toBeNull();

    for (const teardownEvent of ["plugin.worker_stopped", "plugin.unloaded", "plugin.error"]) {
      workerManager.setRunning(true);
      await registrar.syncPlugin(PLUGIN_ID);
      expect(getRepositoryProviderConnector(PROVIDER, { host: HOST })).not.toBeNull();

      lifecycle.emit(teardownEvent, { pluginId: PLUGIN_ID, pluginKey: PLUGIN_KEY });
      expect(
        getRepositoryProviderConnector(PROVIDER, { host: HOST }),
        `${teardownEvent} must drop the registration`,
      ).toBeNull();
    }

    registrar.stop();
  });

  it("drops every registration it owns when stopped", async () => {
    const lifecycle = fakeLifecycle();
    const registrar = createPluginRepositoryProviderRegistrar({
      lifecycle,
      workerManager: fakeWorkerManager(),
      plugins: pluginSource([pluginRecord()]),
    });
    await registrar.start();
    expect(getRepositoryProviderConnector(PROVIDER, { host: HOST })).not.toBeNull();

    registrar.stop();
    expect(getRepositoryProviderConnector(PROVIDER, { host: HOST })).toBeNull();
  });

  it("refuses to let a plugin take over an identity another owner registered", async () => {
    const coreUnregister = repositoryProviderRegistry.register(
      { provider: PROVIDER, async sync() { return { repositories: [] }; } },
      { host: HOST, descriptor: { displayName: "Core", source: "core" } },
    );
    try {
      const lifecycle = fakeLifecycle();
      const registrar = createPluginRepositoryProviderRegistrar({
        lifecycle,
        workerManager: fakeWorkerManager(),
        plugins: pluginSource([pluginRecord()]),
      });
      await registrar.start();

      // The core registration still owns the identity, and it is a bare
      // Foundation adapter — so no connector surface is exposed by the takeover.
      expect(getRepositoryProviderConnector(PROVIDER, { host: HOST })).toBeNull();
      const available = listAvailableRepositoryProviders(randomUUID());
      expect(available.find((entry) => entry.provider === PROVIDER)?.source).toBe("core");
      registrar.stop();
    } finally {
      coreUnregister();
    }
  });
});

describe("capability visibility", () => {
  it("only advertises a provider while its plugin is registered", async () => {
    const companyId = randomUUID();
    const lifecycle = fakeLifecycle();
    const workerManager = fakeWorkerManager();
    const registrar = createPluginRepositoryProviderRegistrar({
      lifecycle,
      workerManager,
      plugins: pluginSource([pluginRecord()]),
    });

    expect(listAvailableRepositoryProviders(companyId).some((entry) => entry.provider === PROVIDER)).toBe(false);

    await registrar.start();
    const advertised = listAvailableRepositoryProviders(companyId).find((entry) => entry.provider === PROVIDER);
    expect(advertised).toMatchObject({
      provider: PROVIDER,
      host: HOST,
      displayName: "GitHub Enterprise",
      source: "plugin",
      pluginKey: PLUGIN_KEY,
      supportsDiscovery: true,
      supportsCloneCredentials: true,
    });

    lifecycle.emit("plugin.worker_stopped", { pluginId: PLUGIN_ID, pluginKey: PLUGIN_KEY });
    expect(listAvailableRepositoryProviders(companyId).some((entry) => entry.provider === PROVIDER)).toBe(false);
    registrar.stop();
  });

  it("keeps another company's scoped provider out of the listing", () => {
    const owner = randomUUID();
    const other = randomUUID();
    const unregister = repositoryProviderRegistry.register(
      { provider: "scoped-provider", async sync() { return { repositories: [] }; } },
      { host: "scoped.example.com", companyId: owner, descriptor: { displayName: "Scoped" } },
    );
    try {
      expect(listAvailableRepositoryProviders(owner).some((entry) => entry.provider === "scoped-provider")).toBe(true);
      expect(listAvailableRepositoryProviders(other).some((entry) => entry.provider === "scoped-provider")).toBe(false);
    } finally {
      unregister();
    }
  });
});

describe("bridge connector", () => {
  const declaration = { providerKey: PROVIDER, displayName: "GitHub Enterprise", host: HOST };

  it("fails closed when the worker is not running", async () => {
    const workerManager = fakeWorkerManager({ running: false });
    const connector = createPluginRepositoryProviderConnector({
      pluginId: PLUGIN_ID,
      pluginKey: PLUGIN_KEY,
      declaration,
      workerManager,
    });

    await expect(connector.discover({ connection: connection() })).rejects.toMatchObject({ status: 422 });
    expect(workerManager.calls).toHaveLength(0);
  });

  it("refuses a connection outside the registered identity", async () => {
    const workerManager = fakeWorkerManager();
    const connector = createPluginRepositoryProviderConnector({
      pluginId: PLUGIN_ID,
      pluginKey: PLUGIN_KEY,
      declaration,
      workerManager,
    });

    await expect(
      connector.discover({ connection: connection({ host: "github.com" }) }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      connector.discover({ connection: connection({ provider: "github" }) }),
    ).rejects.toMatchObject({ status: 422 });
    expect(workerManager.calls).toHaveLength(0);
  });

  it("refuses an installation result that claims another company or host", async () => {
    const companyId = randomUUID();
    const foreignCompany = createPluginRepositoryProviderConnector({
      pluginId: PLUGIN_ID,
      pluginKey: PLUGIN_KEY,
      declaration,
      workerManager: fakeWorkerManager({
        handlers: {
          repositoryProviderCompleteInstallation: () => ({
            companyId: randomUUID(),
            userId: randomUUID(),
            installationId: "install-1",
            accountId: null,
            accountName: null,
            host: HOST,
            providerMetadata: null,
          }),
        },
      }),
    });
    await expect(
      foreignCompany.completeInstallation({ state: "s", installationId: "install-1", companyId }),
    ).rejects.toMatchObject({ status: 422 });

    const foreignHost = createPluginRepositoryProviderConnector({
      pluginId: PLUGIN_ID,
      pluginKey: PLUGIN_KEY,
      declaration,
      workerManager: fakeWorkerManager({
        handlers: {
          repositoryProviderCompleteInstallation: () => ({
            companyId,
            userId: randomUUID(),
            installationId: "install-1",
            accountId: null,
            accountName: null,
            host: "evil.example.com",
            providerMetadata: null,
          }),
        },
      }),
    });
    await expect(
      foreignHost.completeInstallation({ state: "s", installationId: "install-1", companyId }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("sanitizes untrusted provider metadata and drops malformed rows", async () => {
    const connector = createPluginRepositoryProviderConnector({
      pluginId: PLUGIN_ID,
      pluginKey: PLUGIN_KEY,
      declaration,
      workerManager: fakeWorkerManager({
        handlers: {
          repositoryProviderDiscover: () => ({
            items: [
              {
                providerRepositoryId: "1",
                owner: "acme",
                name: "alpha",
                cloneUrl: `https://${HOST}/acme/alpha.git`,
                metadata: { owner: "acme", access_token: "ghs_leak", nested: { private_key: "-----BEGIN" } },
              },
              { owner: "acme", name: "missing-id" },
            ],
            nextCursor: null,
            total: 2,
          }),
        },
      }),
    });

    const page = await connector.discover({ connection: connection() });
    expect(page.items).toHaveLength(1);
    const serialized = JSON.stringify(page.items[0]);
    expect(serialized).not.toContain("ghs_leak");
    expect(serialized).not.toContain("BEGIN");
    expect(page.items[0]?.metadata).toMatchObject({ owner: "acme" });
  });

  it("sanitizes a provider error that embeds a credential", async () => {
    const connector = createPluginRepositoryProviderConnector({
      pluginId: PLUGIN_ID,
      pluginKey: PLUGIN_KEY,
      declaration,
      workerManager: fakeWorkerManager({
        handlers: {
          repositoryProviderSync: () => {
            throw new Error("upstream rejected token=ghs_supersecret for https://user:pw@github.example.com/x");
          },
        },
      }),
    });

    await expect(connector.sync({ connection: connection(), cursor: null })).rejects.toMatchObject({
      status: 422,
    });
    await connector.sync({ connection: connection(), cursor: null }).catch((err: Error) => {
      expect(err.message).not.toContain("ghs_supersecret");
      expect(err.message).not.toContain("user:pw@");
    });
  });

  it("sanitizes HTTP-shaped provider errors while preserving their status", async () => {
    const connector = createPluginRepositoryProviderConnector({
      pluginId: PLUGIN_ID,
      pluginKey: PLUGIN_KEY,
      declaration,
      workerManager: fakeWorkerManager({
        handlers: {
          repositoryProviderSync: () => {
            const error = new Error("provider failed token=ghs_supersecret at https://user:pw@github.example.com/x") as Error & {
              status: number;
              details: unknown;
            };
            error.status = 409;
            error.details = { access_token: "ghs_supersecret" };
            throw error;
          },
        },
      }),
    });

    await connector.sync({ connection: connection(), cursor: null }).catch((error: Error & { status?: number; details?: unknown }) => {
      expect(error.status).toBe(409);
      expect(error.message).not.toContain("ghs_supersecret");
      expect(error.message).not.toContain("user:pw@");
      expect(error.details).toBeUndefined();
    });
  });

  it("rebuilds the credential audit from host-known values and marks it no-store", async () => {
    const conn = connection();
    const connector = createPluginRepositoryProviderConnector({
      pluginId: PLUGIN_ID,
      pluginKey: PLUGIN_KEY,
      declaration,
      workerManager: fakeWorkerManager({
        handlers: {
          repositoryProviderResolveCloneCredential: () => ({
            username: "x-access-token",
            token: "ghs_transient",
            authenticatedCloneUrl: `https://x-access-token:ghs_transient@${HOST}/acme/alpha.git`,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            // A hostile provider trying to attribute its use elsewhere.
            audit: { installationId: "install-1" },
            connectionId: "someone-elses-connection",
          }),
        },
      }),
    });

    const resolved = await connector.resolveCloneCredential({
      connection: conn,
      repository: {
        id: "repo-1",
        providerRepositoryId: "1",
        owner: "acme",
        name: "alpha",
        cloneUrl: `https://${HOST}/acme/alpha.git`,
        host: HOST,
      },
    });

    expect(resolved.token).toBe("ghs_transient");
    expect(resolved.audit).toMatchObject({
      provider: PROVIDER,
      host: HOST,
      connectionId: conn.id,
      repositoryId: "repo-1",
    });

    // Anything that serializes the credential — logs, portability output,
    // prompt rendering — must see a redacted view, not the token.
    const serialized = JSON.stringify(resolved);
    expect(serialized).not.toContain("ghs_transient");
    expect(serialized).toContain("[redacted]");
    expect(JSON.stringify({ credential: resolved })).not.toContain("ghs_transient");
  });

  it("rejects an already-expired or unattached credential", async () => {
    const expired = createPluginRepositoryProviderConnector({
      pluginId: PLUGIN_ID,
      pluginKey: PLUGIN_KEY,
      declaration,
      workerManager: fakeWorkerManager({
        handlers: {
          repositoryProviderResolveCloneCredential: () => ({
            username: "x-access-token",
            token: "ghs_expired",
            authenticatedCloneUrl: `https://x-access-token:ghs_expired@${HOST}/acme/alpha.git`,
            expiresAt: new Date(Date.now() - 1_000).toISOString(),
          }),
        },
      }),
    });
    const repository = {
      id: "repo-1",
      providerRepositoryId: "1",
      owner: "acme",
      name: "alpha",
      cloneUrl: `https://${HOST}/acme/alpha.git`,
      host: HOST,
    };
    await expect(
      expired.resolveCloneCredential({ connection: connection(), repository }),
    ).rejects.toMatchObject({ status: 422 });

    const mismatched = createPluginRepositoryProviderConnector({
      pluginId: PLUGIN_ID,
      pluginKey: PLUGIN_KEY,
      declaration,
      workerManager: fakeWorkerManager({
        handlers: {
          repositoryProviderResolveCloneCredential: () => ({
            username: "x-access-token",
            token: "ghs_one",
            authenticatedCloneUrl: `https://x-access-token:ghs_other@${HOST}/acme/alpha.git`,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
        },
      }),
    });
    await expect(
      mismatched.resolveCloneCredential({ connection: connection(), repository }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("rejects an install URL that is not HTTPS", async () => {
    const connector = createPluginRepositoryProviderConnector({
      pluginId: PLUGIN_ID,
      pluginKey: PLUGIN_KEY,
      declaration,
      workerManager: fakeWorkerManager({
        handlers: {
          repositoryProviderBeginInstallation: () => ({
            installUrl: `http://${HOST}/install`,
            state: "state-1",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
        },
      }),
    });

    await expect(
      connector.beginInstallation({ companyId: randomUUID(), userId: randomUUID() }),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe("no-store credential marker", () => {
  it("redacts the token and clone URL on serialization while keeping them readable", () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const credential = markCloneCredentialNoStore({
      username: "x-access-token",
      token: "ghs_secret",
      authenticatedCloneUrl: "https://x-access-token:ghs_secret@example.com/a/b.git",
      expiresAt,
      audit: {
        provider: PROVIDER,
        host: HOST,
        connectionId: "connection-1",
        repositoryId: "repo-1",
        installationId: "install-1",
        expiresAt,
      },
    });

    expect(credential.token).toBe("ghs_secret");
    expect(JSON.stringify(credential)).not.toContain("ghs_secret");
    expect(JSON.parse(JSON.stringify(credential))).toMatchObject({
      token: "[redacted]",
      authenticatedCloneUrl: "[redacted]",
    });
  });
});
