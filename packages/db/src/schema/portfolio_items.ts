import { pgTable, uuid, text, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const portfolioItems = pgTable("portfolio_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  imageUrl: text("image_url"),
  category: text("category"),
  tags: text("tags").array(),
  clientName: text("client_name"),
  projectUrl: text("project_url"),
  startDate: timestamp("start_date", { withTimezone: true }),
  endDate: timestamp("end_date", { withTimezone: true }),
  sortOrder: integer("sort_order").notNull().default(0),
  isPublished: boolean("is_published").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
