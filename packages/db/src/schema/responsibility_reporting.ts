import { sql } from "drizzle-orm";
import { check, index, integer, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { responsibilities } from "./responsibilities.js";

/**
 * What an agent (or a person correcting it) says about how a responsibility
 * is doing: a status, one line of why, and optional detail. Each report is a
 * row; the newest is the current one. A person-written row carries
 * `user_id`; an agent-written row carries `agent_id`, which becomes null if
 * the agent is deleted later.
 */
export const responsibilityStatusReports = pgTable(
  "responsibility_status_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    responsibilityId: uuid("responsibility_id")
      .notNull()
      .references(() => responsibilities.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    // Auth user id, typed like responsibilities.owner_user_id (no FK to the auth table).
    userId: text("user_id"),
    status: text("status").notNull(),
    message: text("message").notNull(),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    responsibilityCreatedIdx: index("responsibility_status_reports_responsibility_created_idx").on(
      table.responsibilityId,
      table.createdAt.desc(),
    ),
    statusCheck: check(
      "responsibility_status_reports_status_check",
      sql`${table.status} in ('behind', 'at_risk', 'on_track', 'unknown')`,
    ),
    // Never both an agent and a person. Neither is allowed only because an
    // agent's deletion nulls agent_id on the rows it wrote.
    authorCheck: check(
      "responsibility_status_reports_author_check",
      sql`not (${table.agentId} is not null and ${table.userId} is not null)`,
    ),
  }),
);

/**
 * A metric an agent or person defines for a responsibility (beyond its bar).
 * Owned by the responsibility-metrics module.
 */
export const responsibilityMetrics = pgTable(
  "responsibility_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    responsibilityId: uuid("responsibility_id")
      .notNull()
      .references(() => responsibilities.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    title: text("title").notNull(),
    description: text("description"),
    display: text("display").notNull(),
    unit: text("unit"),
    target: numeric("target", { mode: "number" }),
    direction: text("direction"),
    status: text("status").notNull().default("active"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    responsibilityStatusPositionIdx: index("responsibility_metrics_responsibility_status_position_idx").on(
      table.responsibilityId,
      table.status,
      table.position,
    ),
    displayCheck: check(
      "responsibility_metrics_display_check",
      sql`${table.display} in ('number', 'percent', 'line', 'bar')`,
    ),
    directionCheck: check(
      "responsibility_metrics_direction_check",
      sql`${table.direction} is null or ${table.direction} in ('at_least', 'at_most')`,
    ),
    statusCheck: check("responsibility_metrics_status_check", sql`${table.status} in ('active', 'archived')`),
  }),
);

/** One recorded value of a responsibility metric. */
export const responsibilityMetricReadings = pgTable(
  "responsibility_metric_readings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    metricId: uuid("metric_id")
      .notNull()
      .references(() => responsibilityMetrics.id, { onDelete: "cascade" }),
    value: numeric("value", { mode: "number" }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    recordedByAgentId: uuid("recorded_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    recordedByUserId: text("recorded_by_user_id"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    metricRecordedIdx: index("responsibility_metric_readings_metric_recorded_idx").on(
      table.metricId,
      table.recordedAt,
    ),
  }),
);
