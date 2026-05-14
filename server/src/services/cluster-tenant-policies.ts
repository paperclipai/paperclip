import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { clusterTenantPolicies } from "@paperclipai/db";
import type { TenantPolicy } from "@paperclipai/execution-target-kubernetes";

export interface UpsertTenantPolicyInput {
  clusterConnectionId: string;
  companyId: string;
  quota: TenantPolicy["quota"];
  limitRange: TenantPolicy["limitRange"];
  additionalAllowFqdns: string[];
  /**
   * Egress HTTP proxy URL for the tenant. When omitted (undefined), any existing
   * value is preserved on upsert; pass `null` explicitly to clear it.
   */
  httpProxyUrl?: string | null;
  imageOverrides: Record<string, string> | null;
}

export interface TenantPolicyRow extends TenantPolicy {
  clusterConnectionId: string;
  companyId: string;
  httpProxyUrl: string | null;
}

export interface ClusterTenantPoliciesService {
  get(clusterConnectionId: string, companyId: string): Promise<TenantPolicyRow | null>;
  upsert(input: UpsertTenantPolicyInput): Promise<TenantPolicyRow>;
}

export function clusterTenantPoliciesService(db: Db): ClusterTenantPoliciesService {
  return {
    async get(clusterConnectionId, companyId) {
      const [row] = await db.select().from(clusterTenantPolicies).where(and(
        eq(clusterTenantPolicies.clusterConnectionId, clusterConnectionId),
        eq(clusterTenantPolicies.companyId, companyId),
      ));
      return row ? mapRow(row) : null;
    },

    async upsert(input) {
      // We still read existing once to implement the preserve-on-omit
      // semantics for httpProxyUrl. The read is racy w.r.t. another concurrent
      // upsert, but the write below is unconditionally atomic via
      // ON CONFLICT — no caller will surface a unique-constraint error from
      // cluster_tenant_policies_cluster_company_uq. Race semantics under
      // concurrent (omit, set, set, omit, …) call patterns: an explicit
      // setter always overwrites an omitter's preserved value, which is the
      // desired last-explicit-write-wins shape.
      const existing = await this.get(input.clusterConnectionId, input.companyId);
      const httpProxyUrl =
        input.httpProxyUrl === undefined ? (existing?.httpProxyUrl ?? null) : input.httpProxyUrl;
      const networkJson = { additionalAllowFqdns: input.additionalAllowFqdns, httpProxyUrl };

      const [row] = await db
        .insert(clusterTenantPolicies)
        .values({
          clusterConnectionId: input.clusterConnectionId,
          companyId: input.companyId,
          quotaJson: input.quota,
          limitRangeJson: input.limitRange,
          networkJson,
          imageOverridesJson: input.imageOverrides,
        })
        .onConflictDoUpdate({
          target: [clusterTenantPolicies.clusterConnectionId, clusterTenantPolicies.companyId],
          set: {
            quotaJson: input.quota,
            limitRangeJson: input.limitRange,
            networkJson,
            imageOverridesJson: input.imageOverrides,
            updatedAt: sql`now()`,
          },
        })
        .returning();
      return mapRow(row);
    },
  };
}

function mapRow(r: typeof clusterTenantPolicies.$inferSelect): TenantPolicyRow {
  return {
    clusterConnectionId: r.clusterConnectionId,
    companyId: r.companyId,
    quota: r.quotaJson ?? null,
    limitRange: r.limitRangeJson ?? null,
    additionalAllowFqdns: r.networkJson?.additionalAllowFqdns ?? [],
    httpProxyUrl: r.networkJson?.httpProxyUrl ?? null,
    imageOverrides: r.imageOverridesJson ?? null,
  };
}
