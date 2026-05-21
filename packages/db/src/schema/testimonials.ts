import { pgTable, uuid, text, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const testimonials = pgTable("testimonials", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  authorName: text("author_name").notNull(),
  authorRole: text("author_role"),
  authorAvatarUrl: text("author_avatar_url"),
  content: text("content").notNull(),
  rating: integer("rating"),
  sortOrder: integer("sort_order").notNull().default(0),
  isPublished: boolean("is_published").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
