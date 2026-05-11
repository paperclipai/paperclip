import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Links a Slack thread (identified by `thread_ts` + `channel_id`) to a Paperclip
 * resource (issue, approval, draft, ...). Written by Beacon after dispatching a
 * Slack action event, and by `paperclip-slack-comms` after `chat.postMessage`.
 * Read by Beacon to resolve an incoming Slack action payload back to the
 * Paperclip object that originated the thread.
 *
 * Scoped to a `company_id` because the platform is multi-tenant and each
 * company has its own Slack workspace integration. The unique index lives on
 * `(company_id, thread_ts, channel_id)` so a write in one tenant can't observe
 * (via conflict errors) or relink another tenant's binding.
 *
 * One (company_id, thread_ts, channel_id) tuple maps to one Paperclip resource —
 * enforced by the unique index. Idempotent re-write of the same mapping is
 * allowed; relinking the same thread to a different resource is a conflict.
 *
 * Resource type is intentionally `text` rather than an enum so new resource
 * kinds can land without a migration; API-side validation defines the
 * currently accepted values.
 */
export const slackThreadLinks = pgTable(
  "slack_thread_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    threadTs: text("thread_ts").notNull(),
    channelId: text("channel_id").notNull(),
    paperclipResourceType: text("paperclip_resource_type").notNull(),
    paperclipResourceId: uuid("paperclip_resource_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("slack_thread_links_company_idx").on(table.companyId),
    companyThreadChannelUnique: uniqueIndex(
      "slack_thread_links_company_thread_channel_idx",
    ).on(table.companyId, table.threadTs, table.channelId),
  }),
);
