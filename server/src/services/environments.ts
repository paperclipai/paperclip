import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { environmentLeases, environments } from "@paperclipai/db";
import {
  ENVIRONMENT_DRIVERS,
  ENVIRONMENT_LEASE_CLEANUP_STATUSES,
  ENVIRONMENT_LEASE_POLICIES,
  ENVIRONMENT_LEASE_STATUSES,
  ENVIRONMENT_STATUSES,
  type CreateEnvironment,
  type Environment,
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
      const row = await db
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
     * company/instance, configured from operator-supplied config. Mirrors
     * `ensureLocalEnvironment`, with a DB-level partial unique index for the
     * canonical managed row plus a cleanup path for legacy duplicate rows that
     * predate that invariant.
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
      const companyId = typeof companyIdOrConfig === "string" ? companyIdOrConfig : null;
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`managed-kubernetes-environment:${companyId ?? "instance"}`}, 0))`,
        );

        const desiredConfig: Record<string, unknown> = {
          ...config,
          provider: KUBERNETES_PROVIDER_KEY,
        };
        const desiredMetadata: Record<string, unknown> = {
          managedByPaperclip: true,
          [KUBERNETES_MANAGED_MARKER]: true,
        };

        const managedRows = await tx
          .select()
          .from(environments)
          .where(
            companyId
              ? and(eq(environments.companyId, companyId), eq(environments.driver, "sandbox"))
              : eq(environments.driver, "sandbox"),
          )
          .orderBy(asc(environments.createdAt), asc(environments.id))
          .then((rows) =>
            rows.filter(
              (row) =>
                (row.metadata as Record<string, unknown> | null)?.[KUBERNETES_MANAGED_MARKER] === true,
            ),
          );
        const existing = managedRows[0] ?? null;

        const now = new Date();
        if (existing) {
          const updated = await tx
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
          const duplicateIds = managedRows.slice(1).map((row) => row.id);
          if (duplicateIds.length > 0) {
            await tx
              .update(environmentLeases)
              .set({
                environmentId: existing.id,
                updatedAt: now,
              })
              .where(
                companyId
                  ? and(
                    eq(environmentLeases.companyId, companyId),
                    inArray(environmentLeases.environmentId, duplicateIds),
                  )
                  : inArray(environmentLeases.environmentId, duplicateIds),
              );
            await tx
              .delete(environments)
              .where(
                companyId
                  ? and(eq(environments.companyId, companyId), inArray(environments.id, duplicateIds))
                  : inArray(environments.id, duplicateIds),
              );
          }
          return toEnvironment(updated);
        }

        const row = await tx
          .insert(environments)
          .values({
            ...(companyId ? { companyId } : {}),
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
            target: companyId ? [environments.companyId] : [environments.driver],
            where:
              sql`${environments.driver} = 'sandbox' AND (${environments.metadata} ->> 'managedByPaperclip')::boolean = true`,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
        if (row) {
          return toEnvironment(row);
        }
        const winner = await tx
          .select()
          .from(environments)
          .where(
            companyId
              ? and(eq(environments.companyId, companyId), eq(environments.driver, "sandbox"))
              : eq(environments.driver, "sandbox"),
          )
          .orderBy(asc(environments.createdAt), asc(environments.id))
          .then(
            (rows) =>
              rows.find(
                (candidate) =>
                  (candidate.metadata as Record<string, unknown> | null)?.[KUBERNETES_MANAGED_MARKER] === true,
              ) ?? null,
          );
        if (!winner) {
          throw new Error("Failed to ensure kubernetes environment");
        }
        const updated = await tx
          .update(environments)
          .set({
            config: desiredConfig,
            metadata: { ...(winner.metadata ?? {}), ...desiredMetadata },
            status: "active",
            updatedAt: now,
          })
          .where(eq(environments.id, winner.id))
          .returning()
          .then((rows) => rows[0] ?? winner);
        return toEnvironment(updated);
      });
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
      status: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed" | "retained"> = "released",
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
