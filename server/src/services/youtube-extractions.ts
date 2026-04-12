import type { Db } from "@paperclipai/db";
import { youtubeExtractions } from "@paperclipai/db";
import { and, desc, eq } from "drizzle-orm";

export function youtubeExtractionService(db: Db) {
  async function create(input: {
    companyId: string;
    submittedByUserId: string;
    url: string;
  }) {
    const [row] = await db
      .insert(youtubeExtractions)
      .values({
        companyId: input.companyId,
        submittedByUserId: input.submittedByUserId,
        url: input.url,
        status: "processing",
      })
      .returning();
    return row;
  }

  async function list(companyId: string, opts?: { limit?: number; offset?: number }) {
    const query = db
      .select()
      .from(youtubeExtractions)
      .where(eq(youtubeExtractions.companyId, companyId))
      .orderBy(desc(youtubeExtractions.createdAt));

    if (opts?.limit) query.limit(opts.limit);
    if (opts?.offset) query.offset(opts.offset);

    return query;
  }

  async function getById(id: string) {
    const [row] = await db.select().from(youtubeExtractions).where(eq(youtubeExtractions.id, id));
    return row ?? null;
  }

  async function get(id: string, companyId: string) {
    const [row] = await db
      .select()
      .from(youtubeExtractions)
      .where(and(eq(youtubeExtractions.id, id), eq(youtubeExtractions.companyId, companyId)));
    return row ?? null;
  }

  async function update(
    id: string,
    updates: {
      videoId?: string;
      title?: string;
      channel?: string;
      description?: string;
      thumbnailUrl?: string;
      durationSec?: number;
      viewCount?: number;
      likeCount?: number;
      tags?: string[];
      transcript?: string;
      transcriptSource?: string;
      report?: string;
      status?: string;
      errorMessage?: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    const [updated] = await db
      .update(youtubeExtractions)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(youtubeExtractions.id, id))
      .returning();
    return updated ?? null;
  }

  async function remove(id: string, companyId: string) {
    const [deleted] = await db
      .delete(youtubeExtractions)
      .where(and(eq(youtubeExtractions.id, id), eq(youtubeExtractions.companyId, companyId)))
      .returning();
    return deleted ?? null;
  }

  return { create, list, getById, get, update, remove };
}
