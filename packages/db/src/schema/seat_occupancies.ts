import {
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
import { seats } from "./seats.js";
import { agents } from "./agents.js";

export const seatOccupancies = pgTable(
  "seat_occupancies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    seatId: uuid("seat_id").notNull().references(() => seats.id, { onDelete: "cascade" }),
    occupantType: text("occupant_type").notNull(),
    occupantId: text("occupant_id").notNull(),
    occupancyRole: text("occupancy_role").notNull(),
    status: text("status").notNull().default("active"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull().defaultNow(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySeatStatusIdx: index("seat_occupancies_company_seat_status_idx").on(
      table.companyId,
      table.seatId,
      table.status,
    ),
    oneActivePrimaryAgentPerSeatUq: uniqueIndex("seat_occupancies_one_active_primary_agent_per_seat_uq")
      .on(table.seatId)
      .where(sql`${table.occupancyRole} = 'primary_agent' AND ${table.status} = 'active'`),
    oneActiveHumanPerSeatUq: uniqueIndex("seat_occupancies_one_active_human_per_seat_uq")
      .on(table.seatId)
      .where(sql`${table.occupancyRole} = 'human_operator' AND ${table.status} = 'active'`),
    oneActiveShadowAgentPerSeatUq: uniqueIndex("seat_occupancies_one_active_shadow_agent_per_seat_uq")
      .on(table.seatId)
      .where(sql`${table.occupancyRole} = 'shadow_agent' AND ${table.status} = 'active'`),
    companyOccupantStatusIdx: index("seat_occupancies_company_occupant_status_idx").on(
      table.companyId,
      table.occupantType,
      table.occupantId,
      table.status,
    ),
    companyRoleStatusIdx: index("seat_occupancies_company_role_status_idx").on(
      table.companyId,
      table.occupancyRole,
      table.status,
    ),
    seatRoleStartsIdx: index("seat_occupancies_seat_role_starts_idx").on(
      table.seatId,
      table.occupancyRole,
      table.startsAt,
    ),
  }),
);
