import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { repositoryConnections } from "@paperclipai/db";
import type { CreateRepositoryConnection, RepositoryConnection } from "@paperclipai/shared";
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

class RepositoryProviderRegistry {
  private readonly providers = new Map<string, RepositoryProviderAdapter>();

  register(provider: RepositoryProviderAdapter) {
    const key = provider.provider.toLowerCase();
    this.providers.set(key, provider);
    return () => {
      if (this.providers.get(key) === provider) this.providers.delete(key);
    };
  }

  get(provider: string) {
    return this.providers.get(provider.toLowerCase()) ?? null;
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
      if (!registry.get(provider)) throw unprocessable(`Repository provider '${provider}' is not available`);
      const host = normalizeRepositoryHost(input.host);

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
      const provider = registry.get(row.provider);
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
          const syncedRepositories = [];
          for (const snapshot of result.repositories) {
            syncedRepositories.push(
              await transactionalRepositories.upsertProviderRepository(companyId, id, row.provider, snapshot),
            );
          }
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
      const provider = registry.get(row.provider);
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
