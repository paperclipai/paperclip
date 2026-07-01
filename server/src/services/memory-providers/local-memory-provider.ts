import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { memoryEntries } from "@paperclipai/db";
import type {
  MemoryBrowseFilters,
  MemoryEntry,
  MemoryIngestInput,
  MemoryProvider,
  MemorySearchInput,
  MemoryUsage,
} from "@paperclipai/shared";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string) {
  return UUID_RE.test(value);
}

function toMemoryEntry(row: typeof memoryEntries.$inferSelect): MemoryEntry {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    goalId: row.goalId,
    key: row.key,
    title: row.title,
    body: row.body,
    tags: row.tags ?? [],
    source: row.source ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function tagsOverlapCondition(tags: string[]) {
  return sql`${memoryEntries.tags} ?| array[${sql.join(
    tags.map((tag) => sql`${tag}`),
    sql`, `,
  )}]`;
}

const DEFAULT_SEARCH_LIMIT = 50;
const DEFAULT_BROWSE_LIMIT = 50;
const MAX_LIMIT = 200;

function normalizeLimit(limit: number | undefined, fallback: number) {
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit ?? fallback)));
}

export function localMemoryProvider(db: Db): MemoryProvider {
  return {
    async ingest(input: MemoryIngestInput) {
      const [row] = await db
        .insert(memoryEntries)
        .values({
          companyId: input.companyId,
          projectId: input.projectId ?? null,
          goalId: input.goalId ?? null,
          key: input.key,
          title: input.title ?? null,
          body: input.body,
          tags: input.tags ?? [],
          source: input.source ?? null,
        })
        .returning();
      return toMemoryEntry(row);
    },

    async search(input: MemorySearchInput) {
      const conditions = [eq(memoryEntries.companyId, input.companyId)];

      if (input.projectId) conditions.push(eq(memoryEntries.projectId, input.projectId));
      if (input.goalId) conditions.push(eq(memoryEntries.goalId, input.goalId));
      if (input.key) conditions.push(eq(memoryEntries.key, input.key));
      if (input.tags && input.tags.length > 0) conditions.push(tagsOverlapCondition(input.tags));

      if (input.query && input.query.trim().length > 0) {
        const pattern = `%${input.query.trim()}%`;
        conditions.push(
          or(ilike(memoryEntries.title, pattern), ilike(memoryEntries.body, pattern))!,
        );
      }

      const limit = normalizeLimit(input.limit, DEFAULT_SEARCH_LIMIT);

      const rows = await db
        .select()
        .from(memoryEntries)
        .where(and(...conditions))
        .orderBy(desc(memoryEntries.createdAt))
        .limit(limit);

      return rows.map(toMemoryEntry);
    },

    async get(companyId: string, idOrKey: string) {
      if (isUuid(idOrKey)) {
        const row = await db
          .select()
          .from(memoryEntries)
          .where(and(eq(memoryEntries.companyId, companyId), eq(memoryEntries.id, idOrKey)))
          .then((rows) => rows[0] ?? null);
        if (row) return toMemoryEntry(row);
      }

      const row = await db
        .select()
        .from(memoryEntries)
        .where(and(eq(memoryEntries.companyId, companyId), eq(memoryEntries.key, idOrKey)))
        .orderBy(desc(memoryEntries.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      return row ? toMemoryEntry(row) : null;
    },

    async browse(filters: MemoryBrowseFilters) {
      const conditions = [eq(memoryEntries.companyId, filters.companyId)];

      if (filters.projectId) conditions.push(eq(memoryEntries.projectId, filters.projectId));
      if (filters.goalId) conditions.push(eq(memoryEntries.goalId, filters.goalId));
      if (filters.key) conditions.push(eq(memoryEntries.key, filters.key));
      if (filters.tags && filters.tags.length > 0) conditions.push(tagsOverlapCondition(filters.tags));

      const limit = normalizeLimit(filters.limit, DEFAULT_BROWSE_LIMIT);

      const rows = await db
        .select()
        .from(memoryEntries)
        .where(and(...conditions))
        .orderBy(desc(memoryEntries.createdAt))
        .limit(limit);

      return rows.map(toMemoryEntry);
    },

    async forget(companyId: string, id: string) {
      await db
        .delete(memoryEntries)
        .where(and(eq(memoryEntries.companyId, companyId), eq(memoryEntries.id, id)));
    },

    async usage(companyId: string): Promise<MemoryUsage> {
      const [row] = await db
        .select({
          count: sql<number>`count(*)::int`,
          lastIngestedAt: sql<Date | null>`max(${memoryEntries.createdAt})`,
        })
        .from(memoryEntries)
        .where(eq(memoryEntries.companyId, companyId));

      return {
        count: row?.count ?? 0,
        lastIngestedAt: row?.lastIngestedAt ?? null,
      };
    },
  };
}
