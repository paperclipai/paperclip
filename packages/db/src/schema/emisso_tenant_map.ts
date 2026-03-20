import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const emissoTenantMap = pgTable(
  "emisso_tenant_map",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    emissoTenantId: text("emisso_tenant_id").notNull(),
    emissoProjectId: text("emisso_project_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("emisso_tenant_map_company_idx").on(table.companyId),
    uniqueIndex("emisso_tenant_map_tenant_idx").on(table.emissoTenantId),
  ],
);
