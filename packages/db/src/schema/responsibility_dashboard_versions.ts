import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * One saved version of a person's Dashboard (experimental,
 * `enableResponsibilities`): a snapshot of the areas they have something in
 * and the responsibilities they own, saved just before and just after every
 * change set an agent proposed and a person applied, and on every restore, so
 * any change can be undone. Bounded per person (the newest
 * `RESPONSIBILITY_DASHBOARD_VERSION_LIMIT` are kept).
 */
export const responsibilityDashboardVersions = pgTable(
  "responsibility_dashboard_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Auth user id of the person whose dashboard this is, typed like responsibilities.owner_user_id.
    ownerUserId: text("owner_user_id").notNull(),
    /** `change_set`, `person` (changes by hand since the last version) or `restore`. */
    cause: text("cause").notNull(),
    /** One plain line of what changed since the version before it. */
    summary: text("summary").notNull(),
    /** `ResponsibilityDashboardSnapshot` (packages/shared/src/responsibility-dashboard.ts). */
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    /** Hash of the areas and responsibilities, so identical consecutive versions are not saved twice. */
    snapshotHash: text("snapshot_hash").notNull(),
    actorUserId: text("actor_user_id"),
    actorAgentId: uuid("actor_agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** The dashboard conversation the change set came from. */
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    /** The proposal a person applied (archival: no foreign key). */
    interactionId: uuid("interaction_id"),
    /** The version this one followed: Undo restores it. */
    previousVersionId: uuid("previous_version_id")
      .references((): AnyPgColumn => responsibilityDashboardVersions.id, { onDelete: "set null" }),
    /** For a restore: the version that was restored. */
    restoredFromVersionId: uuid("restored_from_version_id")
      .references((): AnyPgColumn => responsibilityDashboardVersions.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerCreatedIdx: index("responsibility_dashboard_versions_owner_created_idx")
      .on(table.companyId, table.ownerUserId, table.createdAt, table.id),
    causeCheck: check(
      "responsibility_dashboard_versions_cause_check",
      sql`${table.cause} in ('change_set', 'person', 'restore')`,
    ),
  }),
);
