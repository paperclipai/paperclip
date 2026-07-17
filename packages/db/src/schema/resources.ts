import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const resources = pgTable(
  "resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    type: text("type").notNull().default("git"),
    repository: text("repository").notNull(),
    sourcePath: text("source_path"),
    defaultRef: text("default_ref").notNull().default("main"),
    mountPath: text("mount_path").notNull(),
    credentialRef: text("credential_ref"),
    labels: jsonb("labels").notNull().default({}),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUq: uniqueIndex("resources_company_key_uq").on(table.companyId, table.key),
    companyMountPathUq: uniqueIndex("resources_company_mount_path_uq").on(table.companyId, table.mountPath),
    companyStatusIdx: index("resources_company_status_idx").on(table.companyId, table.status),
  }),
);
