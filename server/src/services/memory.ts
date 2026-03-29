import { and, desc, eq, ilike, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { memoryBindings, memoryEntries, memoryOperations } from "@paperclipai/db";
import type { MemoryScope, MemorySourceRef } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";

export function memoryService(db: Db) {
  async function logOperation(
    companyId: string,
    bindingId: string,
    operationType: "write" | "query" | "forget",
    scope: MemoryScope,
    latencyMs?: number,
  ) {
    await db.insert(memoryOperations).values({
      companyId,
      bindingId,
      operationType,
      scope,
      latencyMs: latencyMs ?? null,
    });
  }

  return {
    createBinding: async (
      companyId: string,
      key: string,
      providerType: string,
      config: Record<string, unknown> = {},
    ) => {
      const existing = await db
        .select()
        .from(memoryBindings)
        .where(and(eq(memoryBindings.companyId, companyId), eq(memoryBindings.key, key)))
        .then((rows) => rows[0] ?? null);

      if (existing) {
        throw unprocessable(`Memory binding with key "${key}" already exists for this company`);
      }

      const [binding] = await db
        .insert(memoryBindings)
        .values({ companyId, key, providerType, config })
        .returning();

      return binding;
    },

    getBindings: async (companyId: string) => {
      return db
        .select()
        .from(memoryBindings)
        .where(eq(memoryBindings.companyId, companyId))
        .orderBy(memoryBindings.createdAt);
    },

    getBindingByKey: async (companyId: string, key: string) => {
      const binding = await db
        .select()
        .from(memoryBindings)
        .where(and(eq(memoryBindings.companyId, companyId), eq(memoryBindings.key, key)))
        .then((rows) => rows[0] ?? null);

      if (!binding) throw notFound(`Memory binding "${key}" not found`);
      return binding;
    },

    write: async (
      companyId: string,
      bindingKey: string,
      request: {
        scope: MemoryScope;
        source: MemorySourceRef;
        content: string;
        metadata?: Record<string, unknown>;
        mode?: "append" | "upsert";
      },
    ) => {
      const startMs = Date.now();

      const binding = await db
        .select()
        .from(memoryBindings)
        .where(and(eq(memoryBindings.companyId, companyId), eq(memoryBindings.key, bindingKey)))
        .then((rows) => rows[0] ?? null);

      if (!binding) throw notFound(`Memory binding "${bindingKey}" not found`);
      if (!binding.enabled) throw unprocessable(`Memory binding "${bindingKey}" is disabled`);

      const [entry] = await db
        .insert(memoryEntries)
        .values({
          companyId,
          bindingId: binding.id,
          content: request.content,
          sourceKind: request.source.kind,
          sourceRef: request.source,
          metadata: request.metadata ?? {},
        })
        .returning();

      const latencyMs = Date.now() - startMs;
      await logOperation(companyId, binding.id, "write", request.scope, latencyMs);

      return entry;
    },

    query: async (
      companyId: string,
      bindingKey: string,
      request: {
        scope: MemoryScope;
        query: string;
        topK?: number;
      },
    ) => {
      const startMs = Date.now();

      const binding = await db
        .select()
        .from(memoryBindings)
        .where(and(eq(memoryBindings.companyId, companyId), eq(memoryBindings.key, bindingKey)))
        .then((rows) => rows[0] ?? null);

      if (!binding) throw notFound(`Memory binding "${bindingKey}" not found`);

      const topK = request.topK ?? 10;
      const searchPattern = `%${request.query}%`;

      const entries = await db
        .select()
        .from(memoryEntries)
        .where(
          and(
            eq(memoryEntries.companyId, companyId),
            eq(memoryEntries.bindingId, binding.id),
            ilike(memoryEntries.content, searchPattern),
          ),
        )
        .orderBy(desc(memoryEntries.createdAt))
        .limit(topK);

      const latencyMs = Date.now() - startMs;
      await logOperation(companyId, binding.id, "query", request.scope, latencyMs);

      return {
        snippets: entries.map((entry) => ({
          id: entry.id,
          text: entry.content,
          source: entry.sourceRef as MemorySourceRef,
          metadata: entry.metadata as Record<string, unknown>,
          createdAt: entry.createdAt.toISOString(),
        })),
      };
    },

    forget: async (companyId: string, entryId: string) => {
      const entry = await db
        .select()
        .from(memoryEntries)
        .where(and(eq(memoryEntries.id, entryId), eq(memoryEntries.companyId, companyId)))
        .then((rows) => rows[0] ?? null);

      if (!entry) throw notFound("Memory entry not found");

      const startMs = Date.now();

      await db
        .delete(memoryEntries)
        .where(and(eq(memoryEntries.id, entryId), eq(memoryEntries.companyId, companyId)));

      const latencyMs = Date.now() - startMs;
      await logOperation(
        companyId,
        entry.bindingId,
        "forget",
        { companyId },
        latencyMs,
      );

      return { deleted: true };
    },

    getOperations: async (companyId: string, limit = 100) => {
      return db
        .select()
        .from(memoryOperations)
        .where(eq(memoryOperations.companyId, companyId))
        .orderBy(desc(memoryOperations.createdAt))
        .limit(Math.min(limit, 500));
    },
  };
}
