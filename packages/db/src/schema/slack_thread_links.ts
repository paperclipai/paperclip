import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Links a Slack thread (identified by `thread_ts` + `channel_id`) to a Paperclip
 * resource (issue, approval, draft, ...). Written by Beacon after dispatching a
 * Slack action event, and by `paperclip-slack-comms` after `chat.postMessage`.
 * Read by Beacon to resolve an incoming Slack action payload back to the
 * Paperclip object that originated the thread.
 *
 * One Slack thread maps to one Paperclip resource — enforced by the unique
 * index on (thread_ts, channel_id). Idempotent re-write of the same mapping
 * is allowed; relinking the same thread to a different resource is a conflict.
 *
 * Resource type is intentionally `text` rather than an enum so new resource
 * kinds can land without a migration; API-side validation defines the
 * currently accepted values.
 */
export const slackThreadLinks = pgTable(
  "slack_thread_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadTs: text("thread_ts").notNull(),
    channelId: text("channel_id").notNull(),
    paperclipResourceType: text("paperclip_resource_type").notNull(),
    paperclipResourceId: uuid("paperclip_resource_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    threadChannelUnique: uniqueIndex("slack_thread_links_thread_channel_idx").on(
      table.threadTs,
      table.channelId,
    ),
  }),
);
