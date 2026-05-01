import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

/**
 * rt2StoreListings — Public store presence metadata (STORE-01)
 * Supports App Store, Google Play, and other marketplace presences.
 */
export const rt2StoreListings = pgTable(
  "rt2_store_listings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    storeType: text("store_type").notNull(), // "app_store" | "google_play" | "metastore" | "custom"
    listingStatus: text("listing_status").notNull().default("draft"), // "draft" | "pending_review" | "under_review" | "approved" | "rejected" | "suspended" | "removed"
    storeAppId: text("store_app_id"), // External store app ID (e.g., Apple App Store ID)
    storeUrl: text("store_url"),
    appName: text("app_name"),
    appDescription: text("app_description"),
    category: text("category"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    // Reviewer communication tracking
    latestReviewerComment: text("latest_reviewer_comment"),
    latestReviewerCommentAt: timestamp("latest_reviewer_comment_at", { withTimezone: true }),
    currentReviewStatus: text("current_review_status"), // "awaiting_response" | "response_sent" | "resolved" | "escalated"
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("rt2_store_listings_company_status_idx").on(table.companyId, table.listingStatus),
    storeTypeIdx: index("rt2_store_listings_store_type_idx").on(table.storeType),
  }),
);

/**
 * rt2StoreReviewerCommunications — Reviewer communication threads (STORE-02)
 * Each record represents a communication thread with a store reviewer.
 */
export const rt2StoreReviewerCommunications = pgTable(
  "rt2_store_reviewer_communications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    storeListingId: uuid("store_listing_id").notNull().references(() => rt2StoreListings.id, { onDelete: "cascade" }),
    threadSubject: text("thread_subject").notNull(),
    threadStatus: text("thread_status").notNull().default("open"), // "open" | "awaiting_response" | "responded" | "resolved" | "closed"
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    lastMessageBy: text("last_message_by"), // "developer" | "reviewer"
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyListingIdx: index("rt2_store_reviewer_communications_company_listing_idx").on(table.companyId, table.storeListingId),
    threadStatusIdx: index("rt2_store_reviewer_communications_thread_status_idx").on(table.threadStatus),
  }),
);

/**
 * rt2StoreReviewerMessages — Individual messages in reviewer communication threads (STORE-02)
 */
export const rt2StoreReviewerMessages = pgTable(
  "rt2_store_reviewer_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    storeListingId: uuid("store_listing_id").notNull().references(() => rt2StoreListings.id, { onDelete: "cascade" }),
    communicationId: uuid("communication_id").notNull().references(() => rt2StoreReviewerCommunications.id, { onDelete: "cascade" }),
    senderType: text("sender_type").notNull(), // "developer" | "reviewer" | "system"
    senderActorId: text("sender_actor_id"),
    messageContent: text("message_content").notNull(),
    messageType: text("message_type").notNull().default("text"), // "text" | "attachment" | "status_change" | "system_note"
    attachmentUrls: jsonb("attachment_urls").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    communicationIdx: index("rt2_store_reviewer_messages_communication_idx").on(table.communicationId),
    companyCreatedIdx: index("rt2_store_reviewer_messages_company_created_idx").on(table.companyId, table.createdAt),
  }),
);

/**
 * rt2StoreAuditTrails — Company-scoped audit trail for store operations (STORE-02)
 * Tracks all store-related actions for compliance and review.
 */
export const rt2StoreAuditTrails = pgTable(
  "rt2_store_audit_trails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    storeListingId: uuid("store_listing_id").references(() => rt2StoreListings.id, { onDelete: "set null" }),
    action: text("action").notNull(), // "listing_created" | "listing_updated" | "submitted_for_review" | "status_changed" | "reviewer_message_sent" | "reviewer_message_received"
    actorType: text("actor_type").notNull(), // "user" | "agent" | "system"
    actorId: text("actor_id"),
    entityType: text("entity_type").notNull(), // "store_listing" | "reviewer_communication" | "reviewer_message"
    entityId: text("entity_id"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("rt2_store_audit_trails_company_created_idx").on(table.companyId, table.createdAt),
    listingIdx: index("rt2_store_audit_trails_listing_idx").on(table.storeListingId),
    actionIdx: index("rt2_store_audit_trails_action_idx").on(table.action),
  }),
);
