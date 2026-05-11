import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { slackThreadLinks } from "@paperclipai/db";

/**
 * Sentinel thrown when an upsert would relink an existing (thread_ts, channel_id)
 * pair to a different Paperclip resource. The route maps this to HTTP 409 so
 * the caller can see both the existing and requested bindings.
 */
export class SlackThreadLinkConflictError extends Error {
  readonly code = "SLACK_THREAD_LINK_CONFLICT" as const;
  readonly existing: SlackThreadLink;
  constructor(existing: SlackThreadLink) {
    super(
      `Slack thread ${existing.channelId}/${existing.threadTs} is already linked to ` +
        `${existing.paperclipResourceType}:${existing.paperclipResourceId}`,
    );
    this.name = "SlackThreadLinkConflictError";
    this.existing = existing;
  }
}

export interface SlackThreadLink {
  id: string;
  threadTs: string;
  channelId: string;
  paperclipResourceType: string;
  paperclipResourceId: string;
  createdAt: Date;
}

export interface SlackThreadLinkInput {
  threadTs: string;
  channelId: string;
  paperclipResourceType: string;
  paperclipResourceId: string;
}

export function slackThreadLinkService(db: Db) {
  return {
    /**
     * Idempotently link a Slack thread to a Paperclip resource.
     *
     * - First write: inserts and returns `{ row, created: true }`.
     * - Repeat write with same binding: returns existing row with `created: false`.
     * - Repeat write with a *different* binding for the same (threadTs, channelId):
     *   throws `SlackThreadLinkConflictError` carrying the existing row.
     *
     * Insert-then-detect avoids a TOCTOU read-before-write under concurrent
     * Beacon + paperclip-slack-comms writers.
     */
    create: async (
      input: SlackThreadLinkInput,
    ): Promise<{ row: SlackThreadLink; created: boolean }> => {
      const [inserted] = await db
        .insert(slackThreadLinks)
        .values(input)
        .onConflictDoNothing({
          target: [slackThreadLinks.threadTs, slackThreadLinks.channelId],
        })
        .returning();

      if (inserted) {
        return { row: inserted, created: true };
      }

      const [existing] = await db
        .select()
        .from(slackThreadLinks)
        .where(
          and(
            eq(slackThreadLinks.threadTs, input.threadTs),
            eq(slackThreadLinks.channelId, input.channelId),
          ),
        )
        .limit(1);

      if (!existing) {
        // The conflict target matched but the row vanished — extremely unlikely
        // (would require a concurrent delete). Surface as a conflict so the
        // caller can retry rather than silently re-inserting.
        throw new Error("slack thread link conflict resolved but row not found");
      }

      if (
        existing.paperclipResourceType === input.paperclipResourceType &&
        existing.paperclipResourceId === input.paperclipResourceId
      ) {
        return { row: existing, created: false };
      }

      throw new SlackThreadLinkConflictError(existing);
    },

    /**
     * Look up a Slack thread's Paperclip binding by thread timestamp.
     * When `channelId` is supplied, the lookup is exact (matches the unique
     * key). When omitted, returns the most-recent binding for that thread_ts
     * across channels — sufficient because Slack thread_ts values are unique
     * per workspace channel and Beacon always knows the channel anyway.
     */
    findByThreadTs: async (
      threadTs: string,
      channelId?: string,
    ): Promise<SlackThreadLink | null> => {
      const where = channelId
        ? and(eq(slackThreadLinks.threadTs, threadTs), eq(slackThreadLinks.channelId, channelId))
        : eq(slackThreadLinks.threadTs, threadTs);

      const [row] = await db
        .select()
        .from(slackThreadLinks)
        .where(where)
        .orderBy(desc(slackThreadLinks.createdAt))
        .limit(1);

      return row ?? null;
    },
  };
}

export type SlackThreadLinkService = ReturnType<typeof slackThreadLinkService>;
