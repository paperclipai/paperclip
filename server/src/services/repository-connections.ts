import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { repositoryConnections, repositories } from "@paperclipai/db";
import type { CreateRepositoryConnection, RepositoryConnection } from "@paperclipai/shared";
import {
  REPOSITORY_PROVIDER_ANY_HOST,
  normalizeRepositoryProviderHost,
  normalizeRepositoryProviderKey,
  repositoryProviderIdentityKey,
} from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";
import {
  normalizeRepositoryHost,
  sanitizeRepositoryProviderError,
  sanitizeRepositoryProviderMetadata,
} from "./repository-normalization.js";
import { repositoryService, type ProviderRepositorySnapshot } from "./repositories.js";

type RepositoryConnectionRow = typeof repositoryConnections.$inferSelect;

export interface RepositoryProviderAdapter {
  readonly provider: string;
  sync(input: {
    connection: RepositoryConnection;
    cursor: string | null;
  }): Promise<{ repositories: ProviderRepositorySnapshot[]; cursor?: string | null }>;
  disconnect?(input: { connection: RepositoryConnection }): Promise<void>;
}

/**
 * One registered connector identity.
 *
 * Identity is provider **plus** normalized host (plus an optional company
 * scope), so `github` on github.com and `github` on an enterprise install are
 * separate registrations that cannot shadow each other. `ownerKey` records who
 * registered it — core bootstrap leaves it null, the plugin registrar sets
 * `plugin:<pluginId>` so every registration can be torn down on unload.
 */
/**
 * Operator-facing description of a registered connector. Core UI reads this to
 * decide which providers to offer, so it must contain nothing secret — only
 * what an operator would see on a provider picker.
 */
export interface RepositoryProviderDescriptor {
  displayName: string;
  description: string | null;
  /** Where the connector came from — bundled with core vs. an extension. */
  source: "core" | "plugin";
  pluginKey: string | null;
  supportsDiscovery: boolean;
  supportsCloneCredentials: boolean;
  documentationUrl: string | null;
}

export interface RepositoryProviderRegistration {
  readonly provider: string;
  readonly host: string;
  readonly companyId: string | null;
  readonly ownerKey: string | null;
  readonly descriptor: RepositoryProviderDescriptor;
  readonly adapter: RepositoryProviderAdapter;
}

export interface RepositoryProviderRegisterOptions {
  /** Normalized host this connector serves. Defaults to the adapter's own. */
  host?: string | null;
  /** Restrict the registration to one company. Null registers instance-wide. */
  companyId?: string | null;
  /** Owner tag used for lifecycle teardown, e.g. `plugin:<pluginId>`. */
  ownerKey?: string | null;
  /** Operator-facing description surfaced by the capability listing. */
  descriptor?: Partial<RepositoryProviderDescriptor>;
}

export interface RepositoryProviderLookup {
  host?: string | null;
  companyId?: string | null;
}

class RepositoryProviderRegistry {
  private readonly registrations = new Map<string, RepositoryProviderRegistration>();

  /**
   * Registers a connector for one identity.
   *
   * Fails closed on an unusable provider key or host, and refuses to overwrite
   * an identity owned by someone else — otherwise a late-loading extension
   * could silently take over the connector core already trusts for a host.
   */
  register(provider: RepositoryProviderAdapter, options: RepositoryProviderRegisterOptions = {}) {
    const normalizedProvider = normalizeRepositoryProviderKey(provider.provider);
    if (!normalizedProvider) {
      throw new Error(`Repository provider key '${provider.provider}' is not a valid identity`);
    }
    const rawHost = options.host
      ?? (provider as Partial<{ host: string }>).host
      ?? REPOSITORY_PROVIDER_ANY_HOST;
    const normalizedHost = normalizeRepositoryProviderHost(rawHost);
    if (!normalizedHost) {
      throw new Error(`Repository provider host '${rawHost}' is not a valid identity`);
    }
    const companyId = options.companyId ?? null;
    const ownerKey = options.ownerKey ?? null;
    const key = repositoryProviderIdentityKey({ provider: normalizedProvider, host: normalizedHost, companyId });

    const existing = this.registrations.get(key);
    if (existing && existing.ownerKey !== ownerKey) {
      throw new Error(
        `Repository provider '${normalizedProvider}' on host '${normalizedHost}' is already registered by another owner`,
      );
    }

    const registration: RepositoryProviderRegistration = {
      provider: normalizedProvider,
      host: normalizedHost,
      companyId,
      ownerKey,
      descriptor: {
        displayName: options.descriptor?.displayName ?? normalizedProvider,
        description: options.descriptor?.description ?? null,
        source: options.descriptor?.source ?? "core",
        pluginKey: options.descriptor?.pluginKey ?? null,
        supportsDiscovery: options.descriptor?.supportsDiscovery ?? true,
        supportsCloneCredentials: options.descriptor?.supportsCloneCredentials ?? true,
        documentationUrl: options.descriptor?.documentationUrl ?? null,
      },
      adapter: provider,
    };
    this.registrations.set(key, registration);
    return () => {
      if (this.registrations.get(key) === registration) this.registrations.delete(key);
    };
  }

  /**
   * Resolves the connector for a provider, preferring the most specific
   * identity: company + host, then instance + host, then the host-agnostic
   * fallbacks. When no host is supplied and several hosts are registered for
   * the provider the lookup is ambiguous, so it resolves to null rather than
   * guessing which enterprise install the caller meant.
   */
  get(provider: string, lookup: RepositoryProviderLookup = {}) {
    return this.find(provider, lookup)?.adapter ?? null;
  }

  find(provider: string, lookup: RepositoryProviderLookup = {}): RepositoryProviderRegistration | null {
    const normalizedProvider = normalizeRepositoryProviderKey(provider);
    if (!normalizedProvider) return null;
    const companyId = lookup.companyId ?? null;
    const normalizedHost = lookup.host ? normalizeRepositoryProviderHost(lookup.host) : null;
    if (lookup.host && !normalizedHost) return null;

    const candidateKeys = normalizedHost
      ? [
        repositoryProviderIdentityKey({ provider: normalizedProvider, host: normalizedHost, companyId }),
        repositoryProviderIdentityKey({ provider: normalizedProvider, host: normalizedHost, companyId: null }),
      ]
      : [];
    candidateKeys.push(
      repositoryProviderIdentityKey({
        provider: normalizedProvider,
        host: REPOSITORY_PROVIDER_ANY_HOST,
        companyId,
      }),
      repositoryProviderIdentityKey({
        provider: normalizedProvider,
        host: REPOSITORY_PROVIDER_ANY_HOST,
        companyId: null,
      }),
    );
    for (const key of candidateKeys) {
      const registration = this.registrations.get(key);
      if (registration) return registration;
    }
    if (normalizedHost) return null;

    const visible = this.list({ companyId }).filter((entry) => entry.provider === normalizedProvider);
    return visible.length === 1 ? visible[0]! : null;
  }

  /** Every registration visible to a company (instance-wide plus its own). */
  list(lookup: { companyId?: string | null } = {}): RepositoryProviderRegistration[] {
    const companyId = lookup.companyId ?? null;
    return [...this.registrations.values()].filter(
      (registration) => registration.companyId === null || registration.companyId === companyId,
    );
  }

  /** Removes every registration made by an owner. Returns how many were removed. */
  unregisterOwner(ownerKey: string): number {
    let removed = 0;
    for (const [key, registration] of this.registrations) {
      if (registration.ownerKey !== ownerKey) continue;
      this.registrations.delete(key);
      removed += 1;
    }
    return removed;
  }
}

export const repositoryProviderRegistry = new RepositoryProviderRegistry();

export function toRepositoryConnection(row: RepositoryConnectionRow): RepositoryConnection {
  return {
    id: row.id,
    companyId: row.companyId,
    provider: row.provider,
    host: row.host,
    installationId: row.installationId ?? null,
    accountId: row.accountId ?? null,
    accountName: row.accountName ?? null,
    status: row.status as RepositoryConnection["status"],
    syncStatus: row.syncStatus as RepositoryConnection["syncStatus"],
    syncCursor: row.syncCursor ?? null,
    syncError: row.syncError ?? null,
    lastSyncedAt: row.lastSyncedAt ?? null,
    providerMetadata: sanitizeRepositoryProviderMetadata(row.providerMetadata),
    disconnectedAt: row.disconnectedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function repositoryConnectionService(
  db: Db,
  registry: Pick<RepositoryProviderRegistry, "get"> = repositoryProviderRegistry,
) {
  async function getRowById(id: string) {
    return db
      .select()
      .from(repositoryConnections)
      .where(eq(repositoryConnections.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function failOperation(row: RepositoryConnectionRow, error: unknown) {
    const syncError = sanitizeRepositoryProviderError(error);
    const updated = await db
      .update(repositoryConnections)
      .set({ status: "error", syncStatus: "failed", syncError, updatedAt: new Date() })
      .where(and(
        eq(repositoryConnections.companyId, row.companyId),
        eq(repositoryConnections.id, row.id),
      ))
      .returning()
      .then((rows) => rows[0] ?? row);
    return { connection: toRepositoryConnection(updated), syncError };
  }

  return {
    list: async (companyId: string): Promise<RepositoryConnection[]> => {
      const rows = await db
        .select()
        .from(repositoryConnections)
        .where(eq(repositoryConnections.companyId, companyId))
        .orderBy(asc(repositoryConnections.provider), asc(repositoryConnections.host), asc(repositoryConnections.id));
      return rows.map(toRepositoryConnection);
    },

    getById: async (id: string): Promise<RepositoryConnection | null> => {
      const row = await getRowById(id);
      return row ? toRepositoryConnection(row) : null;
    },

    create: async (companyId: string, input: CreateRepositoryConnection) => {
      const provider = input.provider.toLowerCase();
      if (provider === "manual") throw unprocessable("Manual repositories do not use provider connections");
      const host = normalizeRepositoryHost(input.host);
      if (!registry.get(provider, { host, companyId })) {
        throw unprocessable(`Repository provider '${provider}' is not available`);
      }

      if (input.installationId) {
        const existing = await db
          .select()
          .from(repositoryConnections)
          .where(and(
            eq(repositoryConnections.companyId, companyId),
            eq(repositoryConnections.provider, provider),
            eq(repositoryConnections.host, host),
            eq(repositoryConnections.installationId, input.installationId),
          ))
          .then((rows) => rows[0] ?? null);
        if (existing) return { connection: toRepositoryConnection(existing), created: false };
      }

      const row = await db
        .insert(repositoryConnections)
        .values({
          companyId,
          provider,
          host,
          installationId: input.installationId ?? null,
          accountId: input.accountId ?? null,
          accountName: input.accountName ?? null,
        })
        .onConflictDoNothing()
        .returning()
        .then((rows) => rows[0] ?? null);
      if (row) return { connection: toRepositoryConnection(row), created: true };
      const raced = input.installationId
        ? await db
          .select()
          .from(repositoryConnections)
          .where(and(
            eq(repositoryConnections.companyId, companyId),
            eq(repositoryConnections.provider, provider),
            eq(repositoryConnections.host, host),
            eq(repositoryConnections.installationId, input.installationId),
          ))
          .then((rows) => rows[0] ?? null)
        : null;
      if (!raced) throw conflict("Repository connection already exists");
      return { connection: toRepositoryConnection(raced), created: false };
    },

    sync: async (companyId: string, id: string) => {
      const row = await getRowById(id);
      if (!row || row.companyId !== companyId) return null;
      if (row.status === "disconnected") throw conflict("Disconnected repository connection cannot be synced");
      const provider = registry.get(row.provider, { host: row.host, companyId: row.companyId });
      if (!provider) {
        const failed = await failOperation(row, `Repository provider '${row.provider}' is not available`);
        throw unprocessable(failed.syncError, { connection: failed.connection });
      }

      const syncing = await db
        .update(repositoryConnections)
        .set({ syncStatus: "syncing", syncError: null, updatedAt: new Date() })
        .where(and(eq(repositoryConnections.companyId, companyId), eq(repositoryConnections.id, id)))
        .returning()
        .then((rows) => rows[0] ?? row);
      try {
        const result = await provider.sync({
          connection: toRepositoryConnection(syncing),
          cursor: syncing.syncCursor ?? null,
        });
        return await db.transaction(async (tx) => {
          const transactionalRepositories = repositoryService(tx as unknown as Db);
          const importedRows = await tx
            .select({ providerRepositoryId: repositories.providerRepositoryId })
            .from(repositories)
            .where(and(
              eq(repositories.companyId, companyId),
              eq(repositories.connectionId, id),
            ));
          const importedIds = new Set(
            importedRows
              .map((repository) => repository.providerRepositoryId)
              .filter((providerRepositoryId): providerRepositoryId is string => Boolean(providerRepositoryId)),
          );
          const snapshotsById = new Map(
            result.repositories.map((snapshot) => [snapshot.providerRepositoryId, snapshot]),
          );
          const syncedRepositories = [];
          for (const providerRepositoryId of importedIds) {
            const snapshot = snapshotsById.get(providerRepositoryId);
            if (!snapshot) continue;
            syncedRepositories.push(
              (await transactionalRepositories.upsertProviderRepository(companyId, id, row.provider, snapshot)).repository,
            );
          }
          const unavailableIds = [...importedIds].filter((providerRepositoryId) => !snapshotsById.has(providerRepositoryId));
          syncedRepositories.push(...await transactionalRepositories.markProviderRepositoriesUnavailable(
            companyId,
            id,
            unavailableIds,
            "Repository is no longer available through its provider connection",
          ));
          const completed = await tx
            .update(repositoryConnections)
            .set({
              status: "active",
              syncStatus: "succeeded",
              syncCursor: result.cursor ?? syncing.syncCursor ?? null,
              syncError: null,
              lastSyncedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(and(eq(repositoryConnections.companyId, companyId), eq(repositoryConnections.id, id)))
            .returning()
            .then((rows) => rows[0] ?? syncing);
          return { connection: toRepositoryConnection(completed), repositories: syncedRepositories };
        });
      } catch (error) {
        const failed = await failOperation(row, error);
        throw unprocessable(failed.syncError, { connection: failed.connection });
      }
    },

    disconnect: async (companyId: string, id: string) => {
      const row = await getRowById(id);
      if (!row || row.companyId !== companyId) return null;
      if (row.status === "disconnected") return { connection: toRepositoryConnection(row), repositories: [] };
      const provider = registry.get(row.provider, { host: row.host, companyId: row.companyId });
      try {
        await provider?.disconnect?.({ connection: toRepositoryConnection(row) });
      } catch (error) {
        const failed = await failOperation(row, error);
        throw unprocessable(failed.syncError, { connection: failed.connection });
      }

      return await db.transaction(async (tx) => {
        const transactionalRepositories = repositoryService(tx as unknown as Db);
        const unavailableRepositories = await transactionalRepositories.markConnectionUnavailable(
          companyId,
          id,
          "Repository provider connection was disconnected",
        );
        const disconnected = await tx
          .update(repositoryConnections)
          .set({
            status: "disconnected",
            syncStatus: "idle",
            syncError: null,
            disconnectedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(repositoryConnections.companyId, companyId), eq(repositoryConnections.id, id)))
          .returning()
          .then((rows) => rows[0] ?? row);
        return { connection: toRepositoryConnection(disconnected), repositories: unavailableRepositories };
      });
    },
  };
}
