import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { clusterConnections } from "./cluster_connections.js";

export const clusterNamespaceBindings = pgTable(
  "cluster_namespace_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clusterConnectionId: uuid("cluster_connection_id").notNull().references(() => clusterConnections.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    namespaceName: text("namespace_name").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    perClusterCompanyUq: uniqueIndex("cluster_namespace_bindings_cluster_company_uq")
      .on(table.clusterConnectionId, table.companyId),
    namespaceLookupUq: uniqueIndex("cluster_namespace_bindings_cluster_ns_uq")
      .on(table.clusterConnectionId, table.namespaceName),
    companyIdx: index("cluster_namespace_bindings_company_idx").on(table.companyId),
  }),
);
