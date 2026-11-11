import { pgTable, uuid, text, timestamp, jsonb, integer, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const companyUserUiLayouts = pgTable(
  "company_user_ui_layouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    surface: text("surface").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    layout: jsonb("layout").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_user_ui_layouts_company_idx").on(table.companyId),
    companyUserSurfaceUq: uniqueIndex("company_user_ui_layouts_company_user_surface_uq").on(
      table.companyId,
      table.userId,
      table.surface,
    ),
  }),
);
