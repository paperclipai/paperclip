import { and, eq } from "drizzle-orm";
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
  /** FK to company_secrets.id. Omitted = preserve existing; `null` = clear. */
  gitCredentialsSecretId?: string | null;
  /** Cilium DSL: tenant-restrictive FQDN list. Omitted = preserve. Empty array = clear. */
  ciliumDnsAllowlist?: string[];
  /** Cilium DSL: tenant-restrictive CIDR list. Omitted = preserve. Empty array = clear. */
  ciliumEgressCidrs?: string[];
}

export interface TenantPolicyRow extends TenantPolicy {
  clusterConnectionId: string;
  companyId: string;
  httpProxyUrl: string | null;
  gitCredentialsSecretId: string | null;
  ciliumDnsAllowlist: string[];
  ciliumEgressCidrs: string[];
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
      // Pre-read existing once to implement preserve-on-omit semantics for
      // httpProxyUrl, gitCredentialsSecretId, ciliumDnsAllowlist, and
      // ciliumEgressCidrs. The read is racy w.r.t. another concurrent upsert
      // but the write is unconditionally atomic via ON CONFLICT.
      const existing = await this.get(input.clusterConnectionId, input.companyId);
      const httpProxyUrl =
        input.httpProxyUrl === undefined ? (existing?.httpProxyUrl ?? null) : input.httpProxyUrl;
      const gitCredentialsSecretId =
        input.gitCredentialsSecretId === undefined ? (existing?.gitCredentialsSecretId ?? null) : input.gitCredentialsSecretId;
      const ciliumDnsAllowlist =
        input.ciliumDnsAllowlist === undefined ? (existing?.ciliumDnsAllowlist ?? []) : input.ciliumDnsAllowlist;
      const ciliumEgressCidrs =
        input.ciliumEgressCidrs === undefined ? (existing?.ciliumEgressCidrs ?? []) : input.ciliumEgressCidrs;
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
          gitCredentialsSecretId,
          ciliumDnsAllowlist,
          ciliumEgressCidrs,
        })
        .onConflictDoUpdate({
          target: [clusterTenantPolicies.clusterConnectionId, clusterTenantPolicies.companyId],
          set: {
            quotaJson: input.quota,
            limitRangeJson: input.limitRange,
            networkJson,
            imageOverridesJson: input.imageOverrides,
            gitCredentialsSecretId,
            ciliumDnsAllowlist,
            ciliumEgressCidrs,
            updatedAt: new Date(),
          },
        })
        .returning();
      // Drizzle types `.returning()` as `T[]`, so destructuring yields
      // `T | undefined`. An ON CONFLICT DO UPDATE with non-null set values
      // is expected to always emit exactly one row, but guarding here
      // means we surface a real error rather than passing `undefined` to
      // mapRow() and producing a misleading TypeError downstream.
      if (!row) {
        throw new Error(
          "clusterTenantPoliciesService.upsert: insert returning() yielded no rows",
        );
      }
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
    gitCredentialsSecretId: r.gitCredentialsSecretId ?? null,
    ciliumDnsAllowlist: r.ciliumDnsAllowlist ?? [],
    ciliumEgressCidrs: r.ciliumEgressCidrs ?? [],
  };
}
