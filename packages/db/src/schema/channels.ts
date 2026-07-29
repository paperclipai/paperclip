import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  index,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import type {
  ChannelCardKind,
  ChannelKind,
  ChannelMemberRole,
  ChannelMessageType,
  ChannelWorkMode,
  PrincipalType,
} from "@paperclipai/shared";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { approvals } from "./approvals.js";
import { documents } from "./documents.js";
import { issueWorkProducts } from "./issue_work_products.js";
import { issueThreadInteractions } from "./issue_thread_interactions.js";

export const channels = pgTable(
  "channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ChannelKind>().notNull(),
    name: text("name").notNull(),
    slug: text("slug"),
    topic: text("topic"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    dmFingerprint: text("dm_fingerprint"),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("channels_company_idx").on(table.companyId),
    companySlugUnique: uniqueIndex("channels_company_slug_uidx")
      .on(table.companyId, table.slug)
      .where(sql`${table.slug} is not null`),
    companyProjectUnique: uniqueIndex("channels_company_project_uidx")
      .on(table.companyId, table.projectId)
      .where(sql`${table.projectId} is not null`),
    companyDmUnique: uniqueIndex("channels_company_dm_uidx")
      .on(table.companyId, table.dmFingerprint)
      .where(sql`${table.dmFingerprint} is not null`),
  }),
);

export const channelMembers = pgTable(
  "channel_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    principalType: text("principal_type").$type<PrincipalType>().notNull(),
    principalId: text("principal_id").notNull(),
    role: text("role").$type<ChannelMemberRole>().notNull().default("member"),
    muted: boolean("muted").notNull().default(false),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    lastReadMessageId: uuid("last_read_message_id"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    channelIdx: index("channel_members_channel_idx").on(table.channelId),
    companyIdx: index("channel_members_company_idx").on(table.companyId),
    principalUnique: uniqueIndex("channel_members_principal_uidx").on(
      table.channelId,
      table.principalType,
      table.principalId,
    ),
  }),
);

export const channelMessages = pgTable(
  "channel_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    authorType: text("author_type").$type<PrincipalType | "system">().notNull(),
    authorId: text("author_id"),
    messageType: text("message_type").$type<ChannelMessageType>().notNull().default("user"),
    body: text("body").notNull().default(""),
    threadRootId: uuid("thread_root_id"),
    replyToId: uuid("reply_to_id"),
    replyCount: integer("reply_count").notNull().default(0),
    lastReplyAt: timestamp("last_reply_at", { withTimezone: true }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    workProductId: uuid("work_product_id").references(() => issueWorkProducts.id, {
      onDelete: "set null",
    }),
    interactionId: uuid("interaction_id").references(() => issueThreadInteractions.id, {
      onDelete: "set null",
    }),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
    cardKind: text("card_kind").$type<ChannelCardKind>(),
    channelWorkMode: text("channel_work_mode").$type<ChannelWorkMode>(),
    mentionedAgentIds: jsonb("mentioned_agent_ids").$type<string[]>().notNull().default([]),
    mentionedUserIds: jsonb("mentioned_user_ids").$type<string[]>().notNull().default([]),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    channelCreatedIdx: index("channel_messages_channel_created_idx").on(
      table.channelId,
      table.createdAt,
      table.id,
    ),
    companyIdx: index("channel_messages_company_idx").on(table.companyId),
    rootsIdx: index("channel_messages_roots_idx")
      .on(table.channelId, table.createdAt, table.id)
      .where(sql`${table.threadRootId} is null and ${table.deletedAt} is null`),
    threadIdx: index("channel_messages_thread_idx")
      .on(table.threadRootId, table.createdAt, table.id)
      .where(sql`${table.threadRootId} is not null and ${table.deletedAt} is null`),
    issueRootUnique: uniqueIndex("channel_messages_issue_root_uidx")
      .on(table.issueId)
      .where(
        sql`${table.issueId} is not null and ${table.threadRootId} is null and ${table.deletedAt} is null and ${table.cardKind} = 'task'`,
      ),
  }),
);
