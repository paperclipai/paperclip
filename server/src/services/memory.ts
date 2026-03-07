/**
 * Agent memory service — persistent key-value store per agent.
 *
 * Agents can store and retrieve working memory that persists across
 * heartbeat invocations. Values can optionally be stored in HashiCorp
 * Vault for encryption at rest.
 */

import { and, eq, lt, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentMemory } from "@paperclipai/db";
import { notFound } from "../errors.js";

export function memoryService(db: Db) {
  return {
    /** List all memory entries for an agent */
    list: (agentId: string) =>
      db
        .select()
        .from(agentMemory)
        .where(eq(agentMemory.agentId, agentId))
        .orderBy(desc(agentMemory.updatedAt)),

    /** Get a single memory entry by agent + key */
    get: async (agentId: string, key: string) => {
      const rows = await db
        .select()
        .from(agentMemory)
        .where(and(eq(agentMemory.agentId, agentId), eq(agentMemory.key, key)));
      return rows[0] ?? null;
    },

    /** Set (upsert) a memory entry */
    set: async (
      companyId: string,
      agentId: string,
      input: {
        key: string;
        value?: string | null;
        metadata?: Record<string, unknown>;
        ttlSeconds?: number | null;
        vaultRef?: string | null;
      },
    ) => {
      const existing = await db
        .select()
        .from(agentMemory)
        .where(and(eq(agentMemory.agentId, agentId), eq(agentMemory.key, input.key)))
        .then((rows) => rows[0] ?? null);

      const expiresAt =
        input.ttlSeconds != null
          ? new Date(Date.now() + input.ttlSeconds * 1000)
          : null;

      if (existing) {
        return db
          .update(agentMemory)
          .set({
            value: input.value ?? existing.value,
            metadata: input.metadata ?? existing.metadata,
            vaultRef: input.vaultRef ?? existing.vaultRef,
            ttlSeconds: input.ttlSeconds ?? existing.ttlSeconds,
            expiresAt: expiresAt ?? existing.expiresAt,
            updatedAt: new Date(),
          })
          .where(eq(agentMemory.id, existing.id))
          .returning()
          .then((rows) => rows[0]);
      }

      return db
        .insert(agentMemory)
        .values({
          companyId,
          agentId,
          key: input.key,
          value: input.value ?? null,
          metadata: input.metadata ?? {},
          vaultRef: input.vaultRef ?? null,
          ttlSeconds: input.ttlSeconds ?? null,
          expiresAt,
        })
        .returning()
        .then((rows) => rows[0]);
    },

    /** Delete a memory entry */
    delete: async (agentId: string, key: string) => {
      const existing = await db
        .select()
        .from(agentMemory)
        .where(and(eq(agentMemory.agentId, agentId), eq(agentMemory.key, key)))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Memory entry not found");

      await db.delete(agentMemory).where(eq(agentMemory.id, existing.id));
      return existing;
    },

    /** Purge expired memory entries */
    purgeExpired: () =>
      db.delete(agentMemory).where(lt(agentMemory.expiresAt, new Date())),
  };
}
