import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentMemories } from "@paperclipai/db";

export function agentMemoryService(db: Db) {
  return {
    /**
     * List memories for a company, optionally filtered by namespace and/or agent.
     */
    list: async (
      companyId: string,
      opts?: { namespace?: string; agentId?: string; limit?: number },
    ) => {
      const conditions = [eq(agentMemories.companyId, companyId)];
      if (opts?.namespace) {
        conditions.push(eq(agentMemories.namespace, opts.namespace));
      }
      if (opts?.agentId) {
        conditions.push(eq(agentMemories.agentId, opts.agentId));
      }

      const query = db
        .select()
        .from(agentMemories)
        .where(and(...conditions))
        .orderBy(asc(agentMemories.namespace), asc(agentMemories.key));

      return opts?.limit ? query.limit(opts.limit) : query;
    },

    /**
     * Get a single memory by company + namespace + key.
     */
    get: async (companyId: string, namespace: string, key: string) => {
      return db
        .select()
        .from(agentMemories)
        .where(
          and(
            eq(agentMemories.companyId, companyId),
            eq(agentMemories.namespace, namespace),
            eq(agentMemories.key, key),
          ),
        )
        .then((rows) => rows[0] ?? null);
    },

    /**
     * Get a single memory by id.
     */
    getById: async (id: string) => {
      return db
        .select()
        .from(agentMemories)
        .where(eq(agentMemories.id, id))
        .then((rows) => rows[0] ?? null);
    },

    /**
     * Upsert a memory. If a record with the same (companyId, namespace, key)
     * exists, update its value and agentId. Otherwise, insert a new record.
     */
    upsert: async (
      companyId: string,
      data: {
        agentId?: string | null;
        namespace: string;
        key: string;
        value: Record<string, unknown>;
      },
    ) => {
      const now = new Date();
      return db
        .insert(agentMemories)
        .values({
          companyId,
          agentId: data.agentId ?? null,
          namespace: data.namespace,
          key: data.key,
          value: data.value,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [agentMemories.companyId, agentMemories.namespace, agentMemories.key],
          set: {
            value: sql`excluded.value`,
            agentId: sql`excluded.agent_id`,
            updatedAt: now,
          },
        })
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    /**
     * Delete a memory by company + namespace + key.
     */
    delete: async (companyId: string, namespace: string, key: string) => {
      return db
        .delete(agentMemories)
        .where(
          and(
            eq(agentMemories.companyId, companyId),
            eq(agentMemories.namespace, namespace),
            eq(agentMemories.key, key),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    /**
     * Delete a memory by id.
     */
    deleteById: async (id: string) => {
      return db
        .delete(agentMemories)
        .where(eq(agentMemories.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    /**
     * List all distinct namespaces for a company.
     */
    listNamespaces: async (companyId: string) => {
      const rows = await db
        .selectDistinct({ namespace: agentMemories.namespace })
        .from(agentMemories)
        .where(eq(agentMemories.companyId, companyId))
        .orderBy(asc(agentMemories.namespace));
      return rows.map((r) => r.namespace);
    },
  };
}
