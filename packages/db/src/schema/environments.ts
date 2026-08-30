import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const environments = pgTable(
  "environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    driver: text("driver").notNull().default("local"),
    status: text("status").notNull().default("active"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    envVars: jsonb("env_vars").$type<Record<string, unknown>>().notNull().default({}),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index("environments_status_idx").on(table.status),
    localDriverIdx: uniqueIndex("environments_local_driver_idx")
      .on(table.driver)
      .where(sql`${table.driver} = 'local'`),
    managedSandboxIdx: uniqueIndex("environments_managed_sandbox_idx")
      .on(table.driver)
      .where(
        sql`${table.driver} = 'sandbox' AND (${table.metadata} ->> 'managedByPaperclip')::boolean = true`,
      ),
    nameIdx: uniqueIndex("environments_name_idx").on(table.name),
  }),
);
