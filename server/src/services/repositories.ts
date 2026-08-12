import { and, asc, count, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentRepositoryGrants,
  projectRepositories,
  projectWorkspaces,
  repositories,
  repositoryConnections,
} from "@paperclipai/db";
import type {
  CreateManualRepository,
  Repository,
  RepositoryCatalogItem,
  RepositoryContext,
  RepositoryVisibility,
  UpdateRepository,
} from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";
import {
  manualRepositoryIdentityKey,
  normalizeRepositoryLocator,
  normalizeRepositoryWebUrl,
  providerRepositoryIdentityKey,
  sanitizeRepositoryProviderMetadata,
} from "./repository-normalization.js";

type RepositoryRow = typeof repositories.$inferSelect;

export interface ProviderRepositorySnapshot {
  providerRepositoryId: string;
  cloneUrl: string;
  webUrl?: string | null;
  defaultBranch?: string | null;
  visibility?: RepositoryVisibility;
  state?: "active" | "unavailable";
  unavailableReason?: string | null;
  providerMetadata?: Record<string, unknown> | null;
}

export function toRepository(row: RepositoryRow): Repository {
  return {
    id: row.id,
    companyId: row.companyId,
    connectionId: row.connectionId ?? null,
    provider: row.provider,
    providerRepositoryId: row.providerRepositoryId ?? null,
    host: row.host,
    owner: row.owner,
    name: row.name,
    cloneUrl: row.cloneUrl,
    webUrl: row.webUrl ?? null,
    defaultBranch: row.defaultBranch ?? null,
    visibility: row.visibility as Repository["visibility"],
    state: row.state as Repository["state"],
    unavailableReason: row.unavailableReason ?? null,
    providerMetadata: sanitizeRepositoryProviderMetadata(row.providerMetadata),
    archivedAt: row.archivedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Reduce a repository to the stable, secret-free shape that is safe to place in
 * project payloads and agent prompts. Legacy rows may predate URL validation,
 * so invalid or credential-bearing URLs are omitted instead of echoed.
 */
export function toRepositoryContext(
  repository: Pick<Repository, "id" | "provider" | "host" | "owner" | "name" | "state" | "unavailableReason" | "cloneUrl" | "webUrl" | "defaultBranch">,
): RepositoryContext {
  let cloneUrl: string | null = null;
  let webUrl: string | null = null;
  try {
    cloneUrl = normalizeRepositoryLocator(repository.cloneUrl).cloneUrl;
  } catch {
    // Fail closed for pre-normalization rows.
  }
  if (repository.webUrl) {
    try {
      webUrl = normalizeRepositoryWebUrl(repository.webUrl);
    } catch {
      // Fail closed for pre-normalization rows.
    }
  }
  return {
    id: repository.id,
    provider: repository.provider,
    host: repository.host,
    owner: repository.owner,
    name: repository.name,
    state: repository.state,
    unavailableReason: repository.unavailableReason,
    cloneUrl,
    webUrl,
    defaultBranch: repository.defaultBranch,
  };
}

export function repositoryService(db: Db) {
  async function getRowById(id: string) {
    return db.select().from(repositories).where(eq(repositories.id, id)).then((rows) => rows[0] ?? null);
  }

  async function getRowForCompany(companyId: string, id: string) {
    return db
      .select()
      .from(repositories)
      .where(and(eq(repositories.companyId, companyId), eq(repositories.id, id)))
      .then((rows) => rows[0] ?? null);
  }

  return {
    list: async (
      companyId: string,
      opts: { includeArchived?: boolean } = {},
    ): Promise<RepositoryCatalogItem[]> => {
      const rows = await db
        .select()
        .from(repositories)
        .where(
          opts.includeArchived
            ? eq(repositories.companyId, companyId)
            : and(eq(repositories.companyId, companyId), ne(repositories.state, "archived")),
        )
        .orderBy(asc(repositories.host), asc(repositories.owner), asc(repositories.name), asc(repositories.id));
      if (rows.length === 0) return [];
      const repositoryIds = rows.map((row) => row.id);
      const [projectCounts, grantCounts] = await Promise.all([
        db
          .select({ repositoryId: projectRepositories.repositoryId, value: count() })
          .from(projectRepositories)
          .where(and(
            eq(projectRepositories.companyId, companyId),
            inArray(projectRepositories.repositoryId, repositoryIds),
          ))
          .groupBy(projectRepositories.repositoryId),
        db
          .select({ repositoryId: agentRepositoryGrants.repositoryId, value: count() })
          .from(agentRepositoryGrants)
          .where(and(
            eq(agentRepositoryGrants.companyId, companyId),
            inArray(agentRepositoryGrants.repositoryId, repositoryIds),
          ))
          .groupBy(agentRepositoryGrants.repositoryId),
      ]);
      const projectCountById = new Map(projectCounts.map((row) => [row.repositoryId, Number(row.value)]));
      const grantCountById = new Map(grantCounts.map((row) => [row.repositoryId, Number(row.value)]));
      return rows.map((row) => ({
        ...toRepository(row),
        projectCount: projectCountById.get(row.id) ?? 0,
        directGrantCount: grantCountById.get(row.id) ?? 0,
      }));
    },

    getById: async (id: string): Promise<Repository | null> => {
      const row = await getRowById(id);
      return row ? toRepository(row) : null;
    },

    getForCompany: async (companyId: string, id: string): Promise<Repository | null> => {
      const row = await getRowForCompany(companyId, id);
      return row ? toRepository(row) : null;
    },

    findImportedProviderRepositories: async (
      companyId: string,
      provider: string,
      host: string,
      providerRepositoryIds: string[],
    ): Promise<Repository[]> => {
      if (providerRepositoryIds.length === 0) return [];
      const rows = await db
        .select()
        .from(repositories)
        .where(and(
          eq(repositories.companyId, companyId),
          eq(repositories.provider, provider),
          eq(repositories.host, host),
          inArray(repositories.providerRepositoryId, providerRepositoryIds),
        ));
      return rows.map(toRepository);
    },

    createManual: async (companyId: string, input: CreateManualRepository) => {
      const normalized = normalizeRepositoryLocator(input.cloneUrl);
      const identityKey = manualRepositoryIdentityKey(normalized);
      const existing = await db
        .select()
        .from(repositories)
        .where(and(eq(repositories.companyId, companyId), eq(repositories.identityKey, identityKey)))
        .then((rows) => rows[0] ?? null);
      if (existing) return { repository: toRepository(existing), created: false };

      const webUrl = input.webUrl ? normalizeRepositoryWebUrl(input.webUrl) : normalized.webUrl;
      const row = await db
        .insert(repositories)
        .values({
          companyId,
          provider: "manual",
          identityKey,
          host: normalized.host,
          owner: normalized.owner,
          name: normalized.name,
          cloneUrl: normalized.cloneUrl,
          webUrl,
          defaultBranch: input.defaultBranch ?? null,
          visibility: input.visibility,
        })
        .onConflictDoNothing({ target: [repositories.companyId, repositories.identityKey] })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (row) return { repository: toRepository(row), created: true };
      const raced = await db
        .select()
        .from(repositories)
        .where(and(eq(repositories.companyId, companyId), eq(repositories.identityKey, identityKey)))
        .then((rows) => rows[0]);
      return { repository: toRepository(raced!), created: false };
    },

    update: async (companyId: string, id: string, input: UpdateRepository) => {
      const existing = await getRowForCompany(companyId, id);
      if (!existing) return null;
      if (existing.state === "archived") {
        throw conflict("Archived repository cannot be updated");
      }
      if (existing.provider !== "manual") {
        throw conflict("Connected repository identity is managed by its provider");
      }

      const patch: Partial<typeof repositories.$inferInsert> = { updatedAt: new Date() };
      if (input.cloneUrl !== undefined) {
        const normalized = normalizeRepositoryLocator(input.cloneUrl);
        const identityKey = manualRepositoryIdentityKey(normalized);
        const collision = await db
          .select({ id: repositories.id })
          .from(repositories)
          .where(and(
            eq(repositories.companyId, companyId),
            eq(repositories.identityKey, identityKey),
            ne(repositories.id, id),
          ))
          .then((rows) => rows[0] ?? null);
        if (collision) throw conflict("A repository with this remote already exists");
        patch.identityKey = identityKey;
        patch.host = normalized.host;
        patch.owner = normalized.owner;
        patch.name = normalized.name;
        patch.cloneUrl = normalized.cloneUrl;
        if (input.webUrl === undefined) patch.webUrl = normalized.webUrl;
      }
      if (input.webUrl !== undefined) patch.webUrl = input.webUrl ? normalizeRepositoryWebUrl(input.webUrl) : null;
      if (input.defaultBranch !== undefined) patch.defaultBranch = input.defaultBranch;
      if (input.visibility !== undefined) patch.visibility = input.visibility;

      const row = await db.transaction(async (tx) => {
        const updated = await tx
          .update(repositories)
          .set(patch)
          .where(and(eq(repositories.companyId, companyId), eq(repositories.id, id)))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (updated && patch.cloneUrl) {
          await tx
            .update(projectWorkspaces)
            .set({ repoUrl: patch.cloneUrl, updatedAt: new Date() })
            .where(and(
              eq(projectWorkspaces.companyId, companyId),
              eq(projectWorkspaces.repositoryId, id),
            ));
        }
        return updated;
      });
      return row ? toRepository(row) : null;
    },

    archive: async (companyId: string, id: string) => {
      const row = await db
        .update(repositories)
        .set({ state: "archived", archivedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(repositories.companyId, companyId), eq(repositories.id, id)))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toRepository(row) : null;
    },

    upsertProviderRepository: async (
      companyId: string,
      connectionId: string,
      provider: string,
      input: ProviderRepositorySnapshot,
    ) => {
      const connection = await db
        .select()
        .from(repositoryConnections)
        .where(and(
          eq(repositoryConnections.id, connectionId),
          eq(repositoryConnections.companyId, companyId),
          eq(repositoryConnections.provider, provider),
        ))
        .then((rows) => rows[0] ?? null);
      if (!connection || connection.status === "disconnected") {
        throw unprocessable("Repository connection is unavailable");
      }
      const normalized = normalizeRepositoryLocator(input.cloneUrl);
      if (normalized.host !== connection.host) {
        throw unprocessable("Provider repository host does not match its connection");
      }
      const identityKey = providerRepositoryIdentityKey({
        provider,
        host: connection.host,
        providerRepositoryId: input.providerRepositoryId,
      });
      const webUrl = input.webUrl ? normalizeRepositoryWebUrl(input.webUrl) : normalized.webUrl;
      const now = new Date();
      return db.transaction(async (tx) => {
        const values = {
          companyId,
          connectionId,
          provider,
          providerRepositoryId: input.providerRepositoryId,
          identityKey,
          host: normalized.host,
          owner: normalized.owner,
          name: normalized.name,
          cloneUrl: normalized.cloneUrl,
          webUrl,
          defaultBranch: input.defaultBranch ?? null,
          visibility: input.visibility ?? "unknown",
          state: input.state ?? "active",
          unavailableReason: input.unavailableReason ?? null,
          providerMetadata: sanitizeRepositoryProviderMetadata(input.providerMetadata),
          updatedAt: now,
        } satisfies typeof repositories.$inferInsert;
        const updateValues = {
          host: normalized.host,
          owner: normalized.owner,
          name: normalized.name,
          cloneUrl: normalized.cloneUrl,
          webUrl,
          defaultBranch: input.defaultBranch ?? null,
          visibility: input.visibility ?? "unknown",
          state: sql`CASE
            WHEN ${repositories.state} = 'archived' THEN ${repositories.state}
            ELSE ${input.state ?? "active"}
          END`,
          unavailableReason: input.unavailableReason ?? null,
          providerMetadata: sanitizeRepositoryProviderMetadata(input.providerMetadata),
          updatedAt: now,
        };

        let existing = await tx
          .select()
          .from(repositories)
          .where(and(eq(repositories.companyId, companyId), eq(repositories.identityKey, identityKey)))
          .then((rows) => rows[0] ?? null);
        if (existing) {
          if (existing.connectionId === connectionId) {
            existing = await tx
              .update(repositories)
              .set(updateValues)
              .where(and(eq(repositories.companyId, companyId), eq(repositories.id, existing.id)))
              .returning()
              .then((rows) => rows[0] ?? existing);
          }
          return { repository: toRepository(existing), created: false };
        }

        const inserted = await tx
          .insert(repositories)
          .values(values)
          .onConflictDoNothing({ target: [repositories.companyId, repositories.identityKey] })
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!inserted) {
          existing = await tx
            .select()
            .from(repositories)
            .where(and(eq(repositories.companyId, companyId), eq(repositories.identityKey, identityKey)))
            .then((rows) => rows[0] ?? null);
          if (!existing) throw conflict("Repository import conflicted with another request");
          return { repository: toRepository(existing), created: false };
        }
        await tx
          .update(projectWorkspaces)
          .set({ repoUrl: normalized.cloneUrl, updatedAt: now })
          .where(and(
            eq(projectWorkspaces.companyId, companyId),
            eq(projectWorkspaces.repositoryId, inserted.id),
          ));
        return { repository: toRepository(inserted), created: true };
      });
    },

    markConnectionUnavailable: async (companyId: string, connectionId: string, reason: string) => {
      const rows = await db
        .update(repositories)
        .set({ state: "unavailable", unavailableReason: reason, updatedAt: new Date() })
        .where(and(
          eq(repositories.companyId, companyId),
          eq(repositories.connectionId, connectionId),
          ne(repositories.state, "archived"),
        ))
        .returning();
      return rows.map(toRepository);
    },

    markProviderRepositoriesUnavailable: async (
      companyId: string,
      connectionId: string,
      providerRepositoryIds: string[],
      reason: string,
    ) => {
      if (providerRepositoryIds.length === 0) return [];
      const rows = await db
        .update(repositories)
        .set({ state: "unavailable", unavailableReason: reason, updatedAt: new Date() })
        .where(and(
          eq(repositories.companyId, companyId),
          eq(repositories.connectionId, connectionId),
          inArray(repositories.providerRepositoryId, providerRepositoryIds),
          ne(repositories.state, "archived"),
        ))
        .returning();
      return rows.map(toRepository);
    },
  };
}
