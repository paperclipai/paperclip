import { pgTable, uuid, text, timestamp, boolean, index } from "drizzle-orm/pg-core";

export const appDeployments = pgTable(
  "app_deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appName: text("app_name").notNull(),
    imageSha: text("image_sha").notNull(),
    deployedAt: timestamp("deployed_at", { withTimezone: true }).notNull().defaultNow(),
    includesMigration: boolean("includes_migration").notNull().default(false),
    migrationSummary: text("migration_summary"),
    verifiedStable: boolean("verified_stable").notNull().default(false),
    verifiedStableAt: timestamp("verified_stable_at", { withTimezone: true }),
    lastRollbackAt: timestamp("last_rollback_at", { withTimezone: true }),
    dokployDeployId: text("dokploy_deploy_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    appNameIdx: index("app_deployments_app_name_idx").on(table.appName),
    verifiedStableIdx: index("app_deployments_verified_stable_idx").on(table.appName, table.verifiedStable),
    deployedAtIdx: index("app_deployments_deployed_at_idx").on(table.deployedAt),
  }),
);

export type AppDeployment = typeof appDeployments.$inferSelect;
export type NewAppDeployment = typeof appDeployments.$inferInsert;