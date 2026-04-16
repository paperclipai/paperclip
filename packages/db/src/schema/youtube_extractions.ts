import { pgTable, uuid, text, timestamp, index, jsonb, integer } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const youtubeExtractions = pgTable(
  "youtube_extractions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    submittedByUserId: text("submitted_by_user_id").notNull(),
    url: text("url").notNull(),
    videoId: text("video_id"),
    title: text("title"),
    channel: text("channel"),
    description: text("description"),
    thumbnailUrl: text("thumbnail_url"),
    durationSec: integer("duration_sec"),
    viewCount: integer("view_count"),
    likeCount: integer("like_count"),
    tags: jsonb("tags").$type<string[]>(),
    transcript: text("transcript"),
    transcriptSource: text("transcript_source"), // 'manual_subs' | 'auto_subs' | 'none'
    report: text("report"),
    status: text("status").notNull().default("processing"), // 'processing' | 'completed' | 'failed'
    vaultStatus: text("vault_status").notNull().default("pending"), // 'pending' | 'saved' | 'skipped'
    errorMessage: text("error_message"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("youtube_extractions_company_created_idx").on(table.companyId, table.createdAt),
    companyStatusIdx: index("youtube_extractions_company_status_idx").on(table.companyId, table.status),
  }),
);
