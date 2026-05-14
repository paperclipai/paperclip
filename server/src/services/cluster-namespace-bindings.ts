import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { clusterNamespaceBindings } from "@paperclipai/db";

export interface RecordBindingInput {
  clusterConnectionId: string;
  companyId: string;
  namespaceName: string;
}

export interface ClusterNamespaceBindingsService {
  record(input: RecordBindingInput): Promise<void>;
  getByClusterAndCompany(
    clusterConnectionId: string,
    companyId: string,
  ): Promise<{ id: string; namespaceName: string } | null>;
}

export function clusterNamespaceBindingsService(db: Db): ClusterNamespaceBindingsService {
  return {
    async record(input) {
      // Atomic upsert keyed on the (cluster_connection_id, company_id) unique
      // index. The previous select-then-insert had a TOCTOU race under
      // concurrent provisioning: two callers could both observe no existing
      // binding, both INSERT, and one would hit the unique constraint as an
      // unhandled error.
      await db
        .insert(clusterNamespaceBindings)
        .values({
          clusterConnectionId: input.clusterConnectionId,
          companyId: input.companyId,
          namespaceName: input.namespaceName,
        })
        .onConflictDoUpdate({
          target: [clusterNamespaceBindings.clusterConnectionId, clusterNamespaceBindings.companyId],
          set: {
            namespaceName: input.namespaceName,
            updatedAt: sql`now()`,
          },
        });
    },

    async getByClusterAndCompany(clusterConnectionId, companyId) {
      const [row] = await db
        .select()
        .from(clusterNamespaceBindings)
        .where(
          and(
            eq(clusterNamespaceBindings.clusterConnectionId, clusterConnectionId),
            eq(clusterNamespaceBindings.companyId, companyId),
          ),
        );
      return row ? { id: row.id, namespaceName: row.namespaceName } : null;
    },
  };
}
