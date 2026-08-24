import { pgTable, uuid, text, boolean, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";

export const NOTIFICATION_TYPES = [
  "review_requested",
  "approval_needed",
  "work_completed",
  "budget_threshold",
  "execution_error",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_CHANNELS = ["email", "webpush", "in_app"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const DIGEST_FREQUENCIES = ["never", "instant", "daily", "weekly"] as const;
export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number];

export interface NotificationPreference {
  id: string;
  companyId: string;
  userId: string;
  notificationType: NotificationType;
  channel: NotificationChannel;
  enabled: boolean;
  digestFrequency: DigestFrequency | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationPreferenceUpsertInput {
  notificationType: NotificationType;
  channel: NotificationChannel;
  enabled: boolean;
  digestFrequency?: DigestFrequency | null;
}

export interface NotificationRecord {
  id: string;
  companyId: string;
  userId: string;
  notificationType: NotificationType;
  title: string;
  body: string;
  linkUrl: string | null;
  metadataJson: Record<string, unknown>;
  readAt: string | null;
  sentAt: string | null;
  emailSentAt: string | null;
  pushSentAt: string | null;
  createdAt: string;
}

export interface PushSubscription {
  id: string;
  companyId: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  createdAt: string;
}

export interface PushSubscriptionRegisterInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
}

export interface NotificationDigestInput {
  companyId: string;
  frequency: "daily" | "weekly";
}

/** Payload for sending a notification in-code */
export interface NotifyInput {
  companyId: string;
  userId: string;
  notificationType: NotificationType;
  title: string;
  body: string;
  linkUrl?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Drizzle table definitions (migration 0139_notifications.sql)
// ---------------------------------------------------------------------------

export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    notificationType: text("notification_type").notNull(),
    channel: text("channel").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    digestFrequency: text("digest_frequency"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserTypeChannelUq: uniqueIndex("notification_prefs_company_user_type_channel_uq").on(
      table.companyId,
      table.userId,
      table.notificationType,
      table.channel,
    ),
    companyUserIdx: index("notification_prefs_company_user_idx").on(table.companyId, table.userId),
  }),
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    notificationType: text("notification_type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    linkUrl: text("link_url"),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>().notNull().default({}),
    readAt: timestamp("read_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    emailSentAt: timestamp("email_sent_at", { withTimezone: true }),
    pushSentAt: timestamp("push_sent_at", { withTimezone: true }),
    emailDeliveryStatus: text("email_delivery_status"),
    emailDeliveryError: text("email_delivery_error"),
    pushDeliveryStatus: text("push_delivery_status"),
    pushDeliveryError: text("push_delivery_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserIdx: index("notifications_company_user_idx").on(table.companyId, table.userId),
    companyUserCreatedIdx: index("notifications_company_user_created_idx").on(
      table.companyId,
      table.userId,
      table.createdAt,
    ),
    userUnreadIdx: index("notifications_user_unread_idx").on(
      table.userId,
      table.readAt,
      table.createdAt,
    ),
    // Dedup guard for execution_error notifications: at most one notification
    // row per (company, user, runId). Closes the TOCTOU race in
    // notifyExecutionErrorOnce (heartbeat.ts) where a SELECT-then-INSERT dedup
    // could double-fire from parallel heartbeat paths. The partial predicate
    // keeps the constraint scoped to execution_error rows that carry a runId.
    executionErrorRunUserUq: uniqueIndex("notifications_execution_error_run_user_uq")
      .on(table.companyId, table.userId, sql`(metadata_json->>'runId')`)
      .where(
        sql`${table.notificationType} = 'execution_error' AND metadata_json ? 'runId'`,
      ),
  }),
);

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserIdx: index("push_subscriptions_company_user_idx").on(table.companyId, table.userId),
    endpointUq: uniqueIndex("push_subscriptions_endpoint_uq").on(table.endpoint),
  }),
);