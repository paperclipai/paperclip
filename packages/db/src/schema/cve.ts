import { index, integer, pgTable, text, timestamp, uuid, boolean } from "drizzle-orm/pg-core";

export const trackedDependencies = pgTable(
  "tracked_dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    ecosystem: text("ecosystem").notNull(),
    version: text("version"),
    githubRepo: text("github_repo"),
    isActive: boolean("is_active").notNull().default(true),
    alertOnCritical: boolean("alert_on_critical").notNull().default(true),
    alertOnHigh: boolean("alert_on_high").notNull().default(true),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nameIdx: index("tracked_dependencies_name_idx").on(table.name),
    ecosystemIdx: index("tracked_dependencies_ecosystem_idx").on(table.ecosystem),
    isActiveIdx: index("tracked_dependencies_is_active_idx").on(table.isActive),
  }),
);

export type TrackedDependency = typeof trackedDependencies.$inferSelect;
export type NewTrackedDependency = typeof trackedDependencies.$inferInsert;

export const cveEntries = pgTable(
  "cve_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cveId: text("cve_id").notNull().unique(),
    description: text("description").notNull(),
    severity: text("severity").notNull(),
    cvssScore: real("cvss_score"),
    cvssVector: text("cvss_vector"),
    affectedPackages: text("affected_packages").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    lastModifiedAt: timestamp("last_modified_at", { withTimezone: true }),
    references: text("references"),
    isCritical: boolean("is_critical").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    cveIdIdx: index("cve_entries_cve_id_idx").on(table.cveId),
    severityIdx: index("cve_entries_severity_idx").on(table.severity),
    publishedAtIdx: index("cve_entries_published_at_idx").on(table.publishedAt),
    isCriticalIdx: index("cve_entries_is_critical_idx").on(table.isCritical),
  }),
);

export type CveEntry = typeof cveEntries.$inferSelect;
export type NewCveEntry = typeof cveEntries.$inferInsert;

export const cveAlerts = pgTable(
  "cve_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cveId: uuid("cve_id")
      .notNull()
      .references(() => cveEntries.id, { onDelete: "cascade" }),
    dependencyId: uuid("dependency_id")
      .notNull()
      .references(() => trackedDependencies.id, { onDelete: "cascade" }),
    paperclipIssueId: text("paperclip_issue_id"),
    alertStatus: text("alert_status").notNull().default("pending"),
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    cveIdIdx: index("cve_alerts_cve_id_idx").on(table.cveId),
    dependencyIdIdx: index("cve_alerts_dependency_id_idx").on(table.dependencyId),
    alertStatusIdx: index("cve_alerts_alert_status_idx").on(table.alertStatus),
    paperclipIssueIdIdx: index("cve_alerts_paperclip_issue_id_idx").on(table.paperclipIssueId),
  }),
);

export type CveAlert = typeof cveAlerts.$inferSelect;
export type NewCveAlert = typeof cveAlerts.$inferInsert;