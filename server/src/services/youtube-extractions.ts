import type { Db } from "@paperclipai/db";
import { youtubeExtractions } from "@paperclipai/db";
import { and, desc, eq, or } from "drizzle-orm";

/** Extract the YouTube video ID from any common URL format. Returns null if not parseable. */
export function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    // youtu.be/<id>
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("?")[0] || null;
    // youtube.com/watch?v=<id>
    if (u.searchParams.has("v")) return u.searchParams.get("v");
    // youtube.com/shorts/<id> or youtube.com/embed/<id>
    const m = u.pathname.match(/\/(shorts|embed|v)\/([^/?]+)/);
    if (m) return m[2];
  } catch {
    // invalid URL
  }
  return null;
}

/** Normalize a YouTube URL to its canonical watch URL (strips timestamps, playlists, etc.). */
export function normalizeYouTubeUrl(url: string): string {
  const videoId = extractVideoId(url);
  if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
  return url;
}

export function youtubeExtractionService(db: Db) {
  /**
   * Find an existing non-failed extraction for the same video in this company.
   * Checks by normalized URL and by video_id so we catch both "same URL different params"
   * and "same video submitted via different URL format" (after the first extraction completes).
   */
  async function findExisting(companyId: string, url: string) {
    const normalized = normalizeYouTubeUrl(url);
    const videoId = extractVideoId(url);

    const conditions = [eq(youtubeExtractions.url, normalized)];
    if (videoId) conditions.push(eq(youtubeExtractions.videoId, videoId));

    const [row] = await db
      .select()
      .from(youtubeExtractions)
      .where(
        and(
          eq(youtubeExtractions.companyId, companyId),
          or(...conditions),
        ),
      )
      .orderBy(desc(youtubeExtractions.createdAt))
      .limit(1);

    // Only deduplicate against completed or in-progress extractions — let failures be retried
    if (!row || row.status === "failed") return null;
    return row;
  }

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
        url: normalizeYouTubeUrl(input.url),
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

  return { create, findExisting, list, getById, get, update, remove };
}
