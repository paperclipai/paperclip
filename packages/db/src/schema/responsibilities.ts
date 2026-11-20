import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { companySkills } from "./company_skills.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";
import { routines } from "./routines.js";

/**
 * A broad area a company cares about ("Fundraising", "Customers"). An area
 * has no owner and no deadline; responsibilities are filed under it. Agents
 * can only propose areas; a board user (or confirming a responsibility under
 * it) makes one active.
 */
export const responsibilityAreas = pgTable(
  "responsibility_areas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    source: text("source").notNull().default("manual"),
    proposedByAgentId: uuid("proposed_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("responsibility_areas_company_status_idx").on(table.companyId, table.status),
    // At most one non-archived area per company per case-insensitive title.
    companyTitleUq: uniqueIndex("responsibility_areas_company_title_uq")
      .on(table.companyId, sql`lower(${table.title})`)
      .where(sql`${table.status} <> 'archived'`),
    statusCheck: check(
      "responsibility_areas_status_check",
      sql`${table.status} in ('proposed', 'active', 'archived')`,
    ),
    sourceCheck: check("responsibility_areas_source_check", sql`${table.source} in ('manual', 'onboarding')`),
  }),
);

/**
 * Something one person owns inside a company, always ongoing. Its bar is a
 * sentence (`standard`) plus a metric that follows a template (a volume or
 * percentage with a target, a yes or no, or a range); status is derived from
 * the current reading against it. Agents can only propose
 * (status `proposed`) and a board user confirms.
 */
export const responsibilities = pgTable(
  "responsibilities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Auth user id, typed like projects.personal_owner_user_id (no FK to the auth table).
    ownerUserId: text("owner_user_id").notNull(),
    areaId: uuid("area_id").references((): AnyPgColumn => responsibilityAreas.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description"),
    /** The bar, as a sentence. */
    standard: text("standard"),
    /**
     * The bar template (`volume`, `percentage`, `yes_no`, `range`). Null on rows
     * saved before templates existed: they read as `percentage` when the unit
     * is "%", otherwise as `volume`. Not constrained here so a template can be
     * added in one place (packages/shared/src/responsibility-bars.ts); the API
     * validates it.
     */
    metricKind: text("metric_kind"),
    metricName: text("metric_name"),
    metricUnit: text("metric_unit"),
    metricTarget: numeric("metric_target", { mode: "number" }),
    /** Range bars: the lowest and highest values that are still inside. */
    metricLow: numeric("metric_low", { mode: "number" }),
    metricHigh: numeric("metric_high", { mode: "number" }),
    metricCurrent: numeric("metric_current", { mode: "number" }),
    metricDirection: text("metric_direction").default("at_least"),
    metricUpdatedAt: timestamp("metric_updated_at", { withTimezone: true }),
    runByAgentId: uuid("run_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    status: text("status").notNull().default("proposed"),
    source: text("source").notNull().default("manual"),
    evidence: text("evidence"),
    healthOverride: text("health_override"),
    healthNote: text("health_note"),
    sortOrder: integer("sort_order").notNull().default(0),
    proposedByAgentId: uuid("proposed_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyOwnerStatusIdx: index("responsibilities_company_owner_status_idx").on(
      table.companyId,
      table.ownerUserId,
      table.status,
    ),
    areaIdx: index("responsibilities_area_idx").on(table.areaId),
    statusCheck: check(
      "responsibilities_status_check",
      sql`${table.status} in ('proposed', 'active', 'let_go', 'dismissed')`,
    ),
    sourceCheck: check("responsibilities_source_check", sql`${table.source} in ('manual', 'onboarding')`),
    healthOverrideCheck: check(
      "responsibilities_health_override_check",
      sql`${table.healthOverride} is null or ${table.healthOverride} in ('behind', 'at_risk', 'on_track')`,
    ),
    metricDirectionCheck: check(
      "responsibilities_metric_direction_check",
      sql`${table.metricDirection} is null or ${table.metricDirection} in ('at_least', 'at_most')`,
    ),
  }),
);

/**
 * What lives under a responsibility: exactly one project, task, routine or
 * company skill per row. A target can sit under several responsibilities,
 * once each. The responsibilities module owns these links so the issues,
 * projects, routines and skills tables stay unchanged.
 */
export const responsibilityLinks = pgTable(
  "responsibility_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    responsibilityId: uuid("responsibility_id")
      .notNull()
      .references(() => responsibilities.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "cascade" }),
    routineId: uuid("routine_id").references(() => routines.id, { onDelete: "cascade" }),
    /** A company skill filed here by hand, beside the skills of the agents doing the work. */
    skillId: uuid("skill_id").references(() => companySkills.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    responsibilityIdx: index("responsibility_links_responsibility_idx").on(table.responsibilityId),
    projectUq: uniqueIndex("responsibility_links_responsibility_project_uq")
      .on(table.responsibilityId, table.projectId)
      .where(sql`${table.projectId} is not null`),
    issueUq: uniqueIndex("responsibility_links_responsibility_issue_uq")
      .on(table.responsibilityId, table.issueId)
      .where(sql`${table.issueId} is not null`),
    routineUq: uniqueIndex("responsibility_links_responsibility_routine_uq")
      .on(table.responsibilityId, table.routineId)
      .where(sql`${table.routineId} is not null`),
    skillUq: uniqueIndex("responsibility_links_responsibility_skill_uq")
      .on(table.responsibilityId, table.skillId)
      .where(sql`${table.skillId} is not null`),
    projectIdx: index("responsibility_links_project_idx").on(table.projectId),
    issueIdx: index("responsibility_links_issue_idx").on(table.issueId),
    routineIdx: index("responsibility_links_routine_idx").on(table.routineId),
    skillIdx: index("responsibility_links_skill_idx").on(table.skillId),
    singleTargetCheck: check(
      "responsibility_links_single_target_check",
      sql`(${table.projectId} is not null)::int + (${table.issueId} is not null)::int + (${table.routineId} is not null)::int + (${table.skillId} is not null)::int = 1`,
    ),
  }),
);
