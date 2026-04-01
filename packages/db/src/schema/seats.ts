import {
  type AnyPgColumn,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";

export const seats = pgTable(
  "seats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    parentSeatId: uuid("parent_seat_id").references((): AnyPgColumn => seats.id, { onDelete: "set null" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    title: text("title"),
    seatType: text("seat_type").notNull(),
    status: text("status").notNull().default("active"),
    operatingMode: text("operating_mode").notNull().default("vacant"),
    // Keep the DB-level FK in SQL migration. Avoid TS circular init between seats <-> agents here.
    defaultAgentId: uuid("default_agent_id"),
    currentHumanUserId: text("current_human_user_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySlugUniqueIdx: uniqueIndex("seats_company_slug_uq").on(table.companyId, table.slug),
    oneActiveCeoPerCompanyUq: uniqueIndex("seats_one_active_ceo_per_company_uq")
      .on(table.companyId)
      .where(sql`${table.seatType} = 'ceo' AND ${table.status} = 'active'`),
    companyParentIdx: index("seats_company_parent_idx").on(table.companyId, table.parentSeatId),
    companyTypeStatusIdx: index("seats_company_type_status_idx").on(table.companyId, table.seatType, table.status),
    companyModeIdx: index("seats_company_mode_idx").on(table.companyId, table.operatingMode),
    companyDefaultAgentIdx: index("seats_company_default_agent_idx").on(table.companyId, table.defaultAgentId),
  }),
);
