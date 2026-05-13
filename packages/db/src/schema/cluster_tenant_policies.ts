import { pgTable, uuid, jsonb, timestamp, uniqueIndex, index, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { clusterConnections } from "./cluster_connections.js";
import { companySecrets } from "./company_secrets.js";

export const clusterTenantPolicies = pgTable(
  "cluster_tenant_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clusterConnectionId: uuid("cluster_connection_id").notNull().references(() => clusterConnections.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    quotaJson: jsonb("quota_json").$type<{
      requestsCpu?: string;
      requestsMemory?: string;
      limitsCpu?: string;
      limitsMemory?: string;
      requestsStorage?: string;
      countJobs?: number;
      countPvcs?: number;
      countSecrets?: number;
      countConfigMaps?: number;
    } | null>(),
    limitRangeJson: jsonb("limit_range_json").$type<{
      defaultRequest?: { cpu?: string; memory?: string };
      default?:        { cpu?: string; memory?: string };
      max?:            { cpu?: string; memory?: string };
      pvcMaxStorage?: string;
    } | null>(),
    networkJson: jsonb("network_json").$type<{
      additionalAllowFqdns?: string[];
      httpProxyUrl?: string | null;
    } | null>(),
    imageOverridesJson: jsonb("image_overrides_json").$type<Record<string, string> | null>(),
    /** FK -> company_secrets.id. JSON-encoded {username, password} after decryption. Nullable. */
    gitCredentialsSecretId: uuid("git_credentials_secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    /** Cilium DSL: tenant-restrictive FQDN allow-list, intersected with M1 baseline. */
    ciliumDnsAllowlist: text("cilium_dns_allowlist").array().notNull().default(sql`ARRAY[]::text[]`),
    /** Cilium DSL: tenant-restrictive CIDR allow-list, intersected with M1 baseline. */
    ciliumEgressCidrs: text("cilium_egress_cidrs").array().notNull().default(sql`ARRAY[]::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    perClusterCompanyUq: uniqueIndex("cluster_tenant_policies_cluster_company_uq")
      .on(table.clusterConnectionId, table.companyId),
    companyIdx: index("cluster_tenant_policies_company_idx").on(table.companyId),
  }),
);
