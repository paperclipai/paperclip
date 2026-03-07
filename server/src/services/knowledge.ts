/**
 * Knowledge base service — company-scoped shared knowledge.
 *
 * Agents and the board can create, query, and ratify knowledge entries
 * that serve as the organization's source of truth.
 */

import { and, eq, desc, ilike } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { knowledgeEntries } from "@paperclipai/db";
import { notFound } from "../errors.js";

export function knowledgeService(db: Db) {
  return {
    /** List knowledge entries for a company, optionally filtered */
    list: (
      companyId: string,
      filters?: { category?: string; status?: string; search?: string },
    ) => {
      const conditions = [eq(knowledgeEntries.companyId, companyId)];
      if (filters?.category) {
        conditions.push(eq(knowledgeEntries.category, filters.category));
      }
      if (filters?.status) {
        conditions.push(eq(knowledgeEntries.status, filters.status));
      }
      if (filters?.search) {
        conditions.push(ilike(knowledgeEntries.title, `%${filters.search}%`));
      }
      return db
        .select()
        .from(knowledgeEntries)
        .where(and(...conditions))
        .orderBy(desc(knowledgeEntries.updatedAt));
    },

    /** Get a single knowledge entry by ID */
    getById: async (id: string) => {
      const rows = await db
        .select()
        .from(knowledgeEntries)
        .where(eq(knowledgeEntries.id, id));
      return rows[0] ?? null;
    },

    /** Create a knowledge entry */
    create: async (
      companyId: string,
      input: {
        category?: string;
        title: string;
        content: string;
        metadata?: Record<string, unknown>;
        status?: string;
        vaultRef?: string | null;
      },
      actor?: { agentId?: string | null; userId?: string | null },
    ) =>
      db
        .insert(knowledgeEntries)
        .values({
          companyId,
          category: input.category ?? "general",
          title: input.title,
          content: input.content,
          metadata: input.metadata ?? {},
          status: input.status ?? "draft",
          vaultRef: input.vaultRef ?? null,
          authorAgentId: actor?.agentId ?? null,
          authorUserId: actor?.userId ?? null,
        })
        .returning()
        .then((rows) => rows[0]),

    /** Update a knowledge entry */
    update: async (
      id: string,
      patch: {
        category?: string;
        title?: string;
        content?: string;
        metadata?: Record<string, unknown>;
        status?: string;
      },
    ) => {
      const existing = await db
        .select()
        .from(knowledgeEntries)
        .where(eq(knowledgeEntries.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Knowledge entry not found");

      const nextVersion = String(Number(existing.version) + 1);

      return db
        .update(knowledgeEntries)
        .set({
          category: patch.category ?? existing.category,
          title: patch.title ?? existing.title,
          content: patch.content ?? existing.content,
          metadata: patch.metadata ?? existing.metadata,
          status: patch.status ?? existing.status,
          version: nextVersion,
          updatedAt: new Date(),
        })
        .where(eq(knowledgeEntries.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    /** Ratify a knowledge entry (link to a consensus proposal) */
    ratify: async (id: string, proposalId: string) =>
      db
        .update(knowledgeEntries)
        .set({
          status: "ratified",
          ratifiedByProposalId: proposalId,
          updatedAt: new Date(),
        })
        .where(eq(knowledgeEntries.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    /** Delete a knowledge entry */
    remove: async (id: string) => {
      const existing = await db
        .select()
        .from(knowledgeEntries)
        .where(eq(knowledgeEntries.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;
      await db.delete(knowledgeEntries).where(eq(knowledgeEntries.id, id));
      return existing;
    },
  };
}
