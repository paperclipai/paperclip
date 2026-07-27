import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { EnvironmentCustomImageSetupSessionStatus } from "@paperclipai/shared";
import {
  agents,
  companySecretBindings,
  environmentCustomImageSetupSessions,
  environmentLeases,
  environments,
  executionWorkspaces,
  instanceSettings,
  issues,
  projects,
} from "@paperclipai/db";
import {
  ENVIRONMENT_DRIVERS,
  ENVIRONMENT_LEASE_CLEANUP_STATUSES,
  ENVIRONMENT_LEASE_POLICIES,
  ENVIRONMENT_LEASE_STATUSES,
  ENVIRONMENT_STATUSES,
  type CreateEnvironment,
  type Environment,
  type EnvironmentDeleteBlastRadius,
  type EnvironmentDeleteBlockedReason,
  type EnvironmentLease,
  type EnvironmentLeaseCleanupStatus,
  type EnvironmentLeasePolicy,
  type EnvironmentLeaseStatus,
  type UpdateEnvironment,
} from "@paperclipai/shared";
import { conflict } from "../errors.js";

type EnvironmentRow = typeof environments.$inferSelect;
type EnvironmentLeaseRow = typeof environmentLeases.$inferSelect;
const DEFAULT_LOCAL_ENVIRONMENT_NAME = "Local";
const DEFAULT_LOCAL_ENVIRONMENT_DESCRIPTION =
  "Default execution environment for Paperclip runs on this machine.";

const DEFAULT_KUBERNETES_ENVIRONMENT_NAME = "Kubernetes Sandbox";
const DEFAULT_KUBERNETES_ENVIRONMENT_DESCRIPTION =
  "Managed Kubernetes sandbox environment for hosted tenant execution.";
/** Provider key (== plugin driverKey) of the first-party Kubernetes sandbox provider. */
const KUBERNETES_PROVIDER_KEY = "kubernetes";
/** Metadata marker for the company's managed-by-config Kubernetes sandbox environment. */
const KUBERNETES_MANAGED_MARKER = "managedKubernetesSandbox";
export const ACTIVE_CUSTOM_IMAGE_SETUP_STATUSES = [
  "starting",
  "waiting_for_user",
  "capturing",
] as const satisfies readonly EnvironmentCustomImageSetupSessionStatus[];

/**
 * Configuration accepted by `ensureKubernetesEnvironment`. Mirrors the keys of
 * the kubernetes sandbox-provider `configSchema` that an operator typically
 * pins for a hosted cloud instance. Stored verbatim in `environment.config`
 * (the plugin validates/defaults it via `kubernetesProviderConfigSchema` at
 * lease time); `provider` is always forced to "kubernetes".
 */
export interface KubernetesEnvironmentConfigInput {
  backend?: "sandbox-cr" | "job";
  inCluster?: boolean;
  runtimeClassName?: string;
  egressMode?: "cilium" | "standard";
  egressAllowFqdns?: string[];
  egressAllowCidrs?: string[];
  namespacePrefix?: string;
  imageRegistry?: string;
  adapterType?: string;
  /**
   * Sandbox lease RPC timeout in milliseconds. Read at lease time by
   * `resolvePluginSandboxRpcTimeoutMs` to extend the worker-manager call
   * timeout when acquiring a lease may take minutes (e.g. a cold node
   * scale-up on an autoscale-to-zero pool). Stored verbatim in the
   * environment config and validated by the sandbox config schema.
   */
  timeoutMs?: number;
  adapters?: import("@paperclipai/shared").AdapterRegistryEntry[];
  [key: string]: unknown;
}

function cloneRecord(value: unknown, fallback: Record<string, unknown> | null = null): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  return { ...(value as Record<string, unknown>) };
}

function readEnum<T extends string>(value: string | null, allowed: readonly T[], fieldName: string): T | null {
  if (value === null) return null;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`Unexpected ${fieldName} value: ${value}`);
}

function hasConstraintName(error: unknown, constraintName: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    constraint?: unknown;
    constraint_name?: unknown;
    cause?: unknown;
  };
  return candidate.constraint === constraintName
    || candidate.constraint_name === constraintName
    || hasConstraintName(candidate.cause, constraintName);
}

function toEnvironment(row: EnvironmentRow): Environment {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    driver: readEnum(row.driver, ENVIRONMENT_DRIVERS, "environment driver") ?? "local",
    status: readEnum(row.status, ENVIRONMENT_STATUSES, "environment status") ?? "active",
    config: cloneRecord(row.config, {}) ?? {},
    envVars: cloneRecord(row.envVars, {}) ?? {},
    metadata: cloneRecord(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  } as Environment;
}

type EnvironmentListFilters = {
  status?: string;
  driver?: string;
};

function resolveListFilters(
  companyIdOrFilters?: string | EnvironmentListFilters,
  maybeFilters?: EnvironmentListFilters,
): EnvironmentListFilters {
  if (typeof companyIdOrFilters === "string") {
    return maybeFilters ?? {};
  }
  return companyIdOrFilters ?? {};
}

function resolveCreateInput(
  companyIdOrInput: string | CreateEnvironment,
  maybeInput?: CreateEnvironment,
): CreateEnvironment {
  if (typeof companyIdOrInput === "string") {
    if (!maybeInput) throw new Error("Create environment input is required");
    return maybeInput;
  }
  return companyIdOrInput;
}

function resolveKubernetesConfig(
  companyIdOrConfig: string | KubernetesEnvironmentConfigInput,
  maybeConfig?: KubernetesEnvironmentConfigInput,
): KubernetesEnvironmentConfigInput {
  if (typeof companyIdOrConfig === "string") {
    if (!maybeConfig) throw new Error("Kubernetes environment config is required");
    return maybeConfig;
  }
  return companyIdOrConfig;
}

function toEnvironmentLease(row: EnvironmentLeaseRow): EnvironmentLease {
  return {
    id: row.id,
    companyId: row.companyId,
    environmentId: row.environmentId,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    issueId: row.issueId ?? null,
    heartbeatRunId: row.heartbeatRunId ?? null,
    status: readEnum(row.status, ENVIRONMENT_LEASE_STATUSES, "environment lease status") ?? "active",
    leasePolicy: readEnum(row.leasePolicy, ENVIRONMENT_LEASE_POLICIES, "environment lease policy") ?? "ephemeral",
    provider: row.provider ?? null,
    providerLeaseId: row.providerLeaseId ?? null,
    acquiredAt: row.acquiredAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt ?? null,
    releasedAt: row.releasedAt ?? null,
    failureReason: row.failureReason ?? null,
    cleanupStatus: readEnum(
      row.cleanupStatus,
      ENVIRONMENT_LEASE_CLEANUP_STATUSES,
      "environment lease cleanup status",
    ),
    metadata: cloneRecord(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function countFromRows(rows: Array<{ count: number | string | null | undefined }>): number {
  return Number(rows[0]?.count ?? 0);
}

export function environmentService(db: Db) {
  return {
    list: async (
      companyIdOrFilters?: string | EnvironmentListFilters,
      maybeFilters?: EnvironmentListFilters,
    ): Promise<Environment[]> => {
      const filters = resolveListFilters(companyIdOrFilters, maybeFilters);
      const conditions = [];
      if (filters.status) conditions.push(eq(environments.status, filters.status));
      if (filters.driver) conditions.push(eq(environments.driver, filters.driver));
      const rows = await db
        .select()
        .from(environments)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(environments.updatedAt), desc(environments.createdAt));
      return rows.map(toEnvironment);
    },

    getById: async (id: string): Promise<Environment | null> => {
      const row = await db.select().from(environments).where(eq(environments.id, id)).then((rows) => rows[0] ?? null);
      return row ? toEnvironment(row) : null;
    },

    getLeaseById: async (id: string): Promise<EnvironmentLease | null> => {
      const row = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? toEnvironmentLease(row) : null;
    },

    ensureLocalEnvironment: async (_companyId?: string): Promise<Environment> => {
      const now = new Date();
      const insert = () =>
        db
          .insert(environments)
          .values({
            name: DEFAULT_LOCAL_ENVIRONMENT_NAME,
            description: DEFAULT_LOCAL_ENVIRONMENT_DESCRIPTION,
            driver: "local",
            status: "active",
            config: {},
            envVars: {},
            metadata: {
              managedByPaperclip: true,
              defaultForInstance: true,
            },
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({
            target: [environments.driver],
            where: sql`${environments.driver} = 'local'`,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
      const row = await insert().catch((error: unknown) => {
        if (hasConstraintName(error, "environments_name_idx")) {
          return null;
        }
        throw error;
      });
      if (row) return toEnvironment(row);

      const existing = await db
        .select()
        .from(environments)
        .where(eq(environments.driver, "local"))
        .then((rows) => rows[0] ?? null);
      if (!existing) {
        throw new Error("Failed to ensure local environment");
      }
      return toEnvironment(existing);
    },

    /**
     * Idempotently ensure a managed Kubernetes sandbox environment exists for a
     * instance, configured from instance/operator-supplied config. Mirrors
     * `ensureLocalEnvironment`, but there is no DB unique index for sandbox
     * drivers, so idempotency is by metadata marker + driver lookup.
     *
     * The environment is `driver: "sandbox"` with `config.provider:
     * "kubernetes"` so it resolves to the first-party Kubernetes sandbox
     * provider. On subsequent calls the config is refreshed (so operators can
     * update egress/runtimeClass via gitops without recreating the row).
     */
    ensureKubernetesEnvironment: async (
      companyIdOrConfig: string | KubernetesEnvironmentConfigInput,
      maybeConfig?: KubernetesEnvironmentConfigInput,
    ): Promise<Environment> => {
      const config = resolveKubernetesConfig(companyIdOrConfig, maybeConfig);
      const desiredConfig: Record<string, unknown> = {
        ...config,
        provider: KUBERNETES_PROVIDER_KEY,
      };
      const desiredMetadata: Record<string, unknown> = {
        managedByPaperclip: true,
        [KUBERNETES_MANAGED_MARKER]: true,
      };

      const existing = await db
        .select()
        .from(environments)
        .where(eq(environments.driver, "sandbox"))
        .then((rows) =>
          rows.find(
            (row) =>
              (row.metadata as Record<string, unknown> | null)?.[KUBERNETES_MANAGED_MARKER] === true,
          ) ?? null,
        );

      const now = new Date();
      if (existing) {
        const updated = await db
          .update(environments)
          .set({
            config: desiredConfig,
            metadata: { ...(existing.metadata ?? {}), ...desiredMetadata },
            status: "active",
            updatedAt: now,
          })
          .where(eq(environments.id, existing.id))
          .returning()
          .then((rows) => rows[0] ?? existing);
        return toEnvironment(updated);
      }

      // The partial unique index `environments_managed_sandbox_idx` enforces
      // "at most one Paperclip-managed sandbox row per instance" at the DB
      // level. Use ON CONFLICT DO NOTHING keyed on that index so concurrent
      // callers can race the INSERT; losers re-read the surviving row.
      const inserted = await db
        .insert(environments)
        .values({
          name: DEFAULT_KUBERNETES_ENVIRONMENT_NAME,
          description: DEFAULT_KUBERNETES_ENVIRONMENT_DESCRIPTION,
          driver: "sandbox",
          status: "active",
          config: desiredConfig,
          envVars: {},
          metadata: desiredMetadata,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [environments.driver],
          where:
            sql`${environments.driver} = 'sandbox' AND (${environments.metadata} ->> 'managedByPaperclip')::boolean = true`,
        })
        .returning()
        .then((rows) => rows[0] ?? null)
        .catch((error) => {
          if (
            hasConstraintName(error, "environments_name_idx")
            || hasConstraintName(error, "environments_managed_sandbox_idx")
          ) {
            return null;
          }
          throw error;
        });
      if (inserted) return toEnvironment(inserted);

      const winner = await db
        .select()
        .from(environments)
        .where(eq(environments.driver, "sandbox"))
        .then(
          (rows) =>
            rows.find(
              (candidate) =>
                (candidate.metadata as Record<string, unknown> | null)?.[
                  KUBERNETES_MANAGED_MARKER
                ] === true,
            ) ?? null,
        );
      if (!winner) {
        throw new Error("Failed to ensure kubernetes environment");
      }
      return toEnvironment(winner);
    },

    /**
     * Find the active managed Kubernetes sandbox environment, if one
     * exists. Read-only counterpart to `ensureKubernetesEnvironment` used by the
     * per-run execution guard (which must not silently create config-less envs).
     */
    findKubernetesEnvironment: async (_companyId?: string): Promise<Environment | null> => {
      const rows = await db
        .select()
        .from(environments)
        .where(
          and(
            eq(environments.driver, "sandbox"),
            eq(environments.status, "active"),
          ),
        )
        .orderBy(desc(environments.updatedAt));
      const match = rows.find(
        (row) =>
          (row.metadata as Record<string, unknown> | null)?.[KUBERNETES_MANAGED_MARKER] === true,
      );
      return match ? toEnvironment(match) : null;
    },

    create: async (
      companyIdOrInput: string | CreateEnvironment,
      maybeInput?: CreateEnvironment,
    ): Promise<Environment> => {
      const input = resolveCreateInput(companyIdOrInput, maybeInput);
      const now = new Date();
      const row = await db
        .insert(environments)
        .values({
          name: input.name,
          description: input.description ?? null,
          driver: input.driver,
          status: input.status ?? "active",
          config: input.config ?? {},
          envVars: (input as CreateEnvironment & { envVars?: Record<string, unknown> }).envVars ?? {},
          metadata: input.metadata ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0] ?? null)
        .catch((error) => {
          if (hasConstraintName(error, "environments_name_idx")) {
            throw conflict(`An environment named "${input.name}" already exists for this instance.`);
          }
          if (hasConstraintName(error, "environments_local_driver_idx")) {
            throw conflict("A local environment already exists for this instance.");
          }
          throw error;
        });
      if (!row) {
        throw new Error("Failed to create environment");
      }
      return toEnvironment(row);
    },

    update: async (id: string, patch: UpdateEnvironment): Promise<Environment | null> => {
      const values: Partial<typeof environments.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (patch.name !== undefined) values.name = patch.name;
      if (patch.description !== undefined) values.description = patch.description ?? null;
      if (patch.driver !== undefined) values.driver = patch.driver;
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.config !== undefined) values.config = patch.config;
      if ("envVars" in patch && patch.envVars !== undefined) {
        values.envVars = (patch.envVars ?? {}) as Record<string, unknown>;
      }
      if (patch.metadata !== undefined) values.metadata = patch.metadata ?? null;

      const row = await db
        .update(environments)
        .set(values)
        .where(eq(environments.id, id))
        .returning()
        .then((rows) => rows[0] ?? null)
        .catch((error) => {
          if (hasConstraintName(error, "environments_name_idx")) {
            throw conflict(`An environment named "${patch.name}" already exists for this instance.`);
          }
          if (hasConstraintName(error, "environments_local_driver_idx")) {
            throw conflict("A local environment already exists for this instance.");
          }
          throw error;
        });
      return row ? toEnvironment(row) : null;
    },

    remove: async (id: string): Promise<Environment | null> => {
      const row = await db
        .delete(environments)
        .where(eq(environments.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toEnvironment(row) : null;
    },

    removeIfDeletable: async (id: string): Promise<Environment | null> => {
      const row = await db
        .delete(environments)
        .where(
          and(
            eq(environments.id, id),
            ne(environments.driver, "local"),
            sql`not exists (
              select 1 from ${instanceSettings}
              where ${instanceSettings.defaultEnvironmentId} = ${environments.id}
            )`,
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toEnvironment(row) : null;
    },

    getDeleteBlastRadius: async (id: string): Promise<EnvironmentDeleteBlastRadius | null> => {
      const environment = await db
        .select({
          id: environments.id,
          driver: environments.driver,
        })
        .from(environments)
        .where(eq(environments.id, id))
        .then((rows) => rows[0] ?? null);
      if (!environment) return null;

      const [
        instanceDefaultRows,
        agentDefaultRows,
        executionWorkspaceRows,
        issueRows,
        projectRows,
        secretBindingRows,
        activeLeaseRows,
        activeSetupRows,
      ] = await Promise.all([
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(instanceSettings)
          .where(eq(instanceSettings.defaultEnvironmentId, id)),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(agents)
          .where(eq(agents.defaultEnvironmentId, id)),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(executionWorkspaces)
          .where(sql`${executionWorkspaces.metadata} -> 'config' ->> 'environmentId' = ${id}`),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(issues)
          .where(sql`${issues.executionWorkspaceSettings} ->> 'environmentId' = ${id}`),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(projects)
          .where(sql`${projects.executionWorkspacePolicy} ->> 'environmentId' = ${id}`),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(companySecretBindings)
          .where(
            and(
              eq(companySecretBindings.targetType, "environment"),
              eq(companySecretBindings.targetId, id),
            ),
          ),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(environmentLeases)
          .where(
            and(
              eq(environmentLeases.environmentId, id),
              eq(environmentLeases.status, "active"),
            ),
          ),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(environmentCustomImageSetupSessions)
          .where(
            and(
              eq(environmentCustomImageSetupSessions.environmentId, id),
              inArray(environmentCustomImageSetupSessions.status, [...ACTIVE_CUSTOM_IMAGE_SETUP_STATUSES]),
            ),
          ),
      ]);

      const isManagedLocal = environment.driver === "local";
      const isInstanceDefault = countFromRows(instanceDefaultRows) > 0;
      const activeLeaseCount = countFromRows(activeLeaseRows);
      const activeCustomImageSetupSessionCount = countFromRows(activeSetupRows);
      const hasActiveRuntimeUse = activeLeaseCount > 0 || activeCustomImageSetupSessionCount > 0;
      const deleteBlockedReasons: EnvironmentDeleteBlockedReason[] = [];
      if (isManagedLocal) deleteBlockedReasons.push("managed_local");
      if (isInstanceDefault) deleteBlockedReasons.push("instance_default");
      if (hasActiveRuntimeUse) deleteBlockedReasons.push("active_runtime_use");

      return {
        environmentId: id,
        canDelete: deleteBlockedReasons.length === 0,
        deleteBlockedReasons,
        staticReferences: {
          isManagedLocal,
          isInstanceDefault,
          agentDefaultCount: countFromRows(agentDefaultRows),
          executionWorkspaceSelectionCount: countFromRows(executionWorkspaceRows),
          issueSelectionCount: countFromRows(issueRows),
          projectSelectionCount: countFromRows(projectRows),
          secretBindingCount: countFromRows(secretBindingRows),
        },
        activeRuntimeUse: {
          activeLeaseCount,
          activeCustomImageSetupSessionCount,
          hasActiveRuntimeUse,
        },
      };
    },

    releaseActiveLeasesForEnvironment: async (id: string): Promise<number> => {
      const now = new Date();
      const rows = await db
        .update(environmentLeases)
        .set({ status: "released", releasedAt: now, lastUsedAt: now, updatedAt: now })
        .where(and(eq(environmentLeases.environmentId, id), eq(environmentLeases.status, "active")))
        .returning();
      return rows.length;
    },

    listLeases: async (
      environmentId: string,
      filters: {
        status?: string;
      } = {},
    ): Promise<EnvironmentLease[]> => {
      const conditions = [eq(environmentLeases.environmentId, environmentId)];
      if (filters.status) conditions.push(eq(environmentLeases.status, filters.status));
      const rows = await db
        .select()
        .from(environmentLeases)
        .where(and(...conditions))
        .orderBy(desc(environmentLeases.lastUsedAt), desc(environmentLeases.createdAt));
      return rows.map(toEnvironmentLease);
    },

    acquireLease: async (input: {
      companyId: string;
      environmentId: string;
      executionWorkspaceId?: string | null;
      issueId?: string | null;
      heartbeatRunId?: string | null;
      leasePolicy?: EnvironmentLeasePolicy;
      provider?: string | null;
      providerLeaseId?: string | null;
      expiresAt?: Date | null;
      metadata?: Record<string, unknown> | null;
    }): Promise<EnvironmentLease> => {
      const now = new Date();
      const row = await db
        .insert(environmentLeases)
        .values({
          companyId: input.companyId,
          environmentId: input.environmentId,
          executionWorkspaceId: input.executionWorkspaceId ?? null,
          issueId: input.issueId ?? null,
          heartbeatRunId: input.heartbeatRunId ?? null,
          status: "active",
          leasePolicy: input.leasePolicy ?? "ephemeral",
          provider: input.provider ?? null,
          providerLeaseId: input.providerLeaseId ?? null,
          acquiredAt: now,
          lastUsedAt: now,
          expiresAt: input.expiresAt ?? null,
          releasedAt: null,
          failureReason: null,
          cleanupStatus: null,
          metadata: input.metadata ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!row) {
        throw new Error("Failed to acquire environment lease");
      }
      return toEnvironmentLease(row);
    },

    releaseLease: async (
      id: string,
      status: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed" | "retained" | "pending_cleanup"> = "released",
      options?: {
        failureReason?: string;
        cleanupStatus?: EnvironmentLeaseCleanupStatus;
      },
    ) => {
      const now = new Date();
      const row = await db
        .update(environmentLeases)
        .set({
          status,
          releasedAt: status === "retained" ? null : now,
          lastUsedAt: now,
          updatedAt: now,
          ...(options?.failureReason !== undefined ? { failureReason: options.failureReason } : {}),
          ...(options?.cleanupStatus !== undefined ? { cleanupStatus: options.cleanupStatus } : {}),
        })
        .where(eq(environmentLeases.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toEnvironmentLease(row) : null;
    },

    updateLeaseMetadata: async (
      id: string,
      metadata: Record<string, unknown> | null,
    ): Promise<EnvironmentLease | null> => {
      const row = await db
        .update(environmentLeases)
        .set({
          metadata,
          lastUsedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(environmentLeases.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toEnvironmentLease(row) : null;
    },

    releaseLeasesForRun: async (
      heartbeatRunId: string,
      status: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed"> = "released",
    ): Promise<EnvironmentLease[]> => {
      const now = new Date();
      const rows = await db
        .update(environmentLeases)
        .set({
          status,
          releasedAt: now,
          lastUsedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(environmentLeases.heartbeatRunId, heartbeatRunId),
            eq(environmentLeases.status, "active"),
          ),
        )
        .returning();
      return rows.map(toEnvironmentLease);
    },
  };
}
