import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
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
import { isCloudManagedInstance } from "./cloud-instance.js";

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
const ACTIVE_CUSTOM_IMAGE_SETUP_STATUSES = ["starting", "waiting_for_user", "capturing"] as const;

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

/**
 * Input to `ensureManagedSandboxEnvironment`. Provider-agnostic: `provider`
 * is the sandbox plugin's driver key and is forced into `config.provider`;
 * the rest of `config` is stored verbatim for the plugin to validate at
 * lease time.
 */
export interface ManagedSandboxEnvironmentInput {
  name: string;
  description?: string;
  /** Sandbox provider key (the plugin's driverKey, e.g. "kubernetes", "daytona"). */
  provider: string;
  config?: Record<string, unknown>;
  /**
   * Extra metadata markers stamped on the managed row (e.g. the legacy
   * kubernetes marker `managedKubernetesSandbox` that
   * `findKubernetesEnvironment` keys on).
   */
  extraMetadata?: Record<string, unknown>;
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

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type EnvironmentWriteDb = Pick<Db | DbTransaction, "select" | "insert" | "update" | "delete">;

export function environmentService(db: Db) {
  /** The single Paperclip-managed sandbox row (`environments_managed_sandbox_idx`), if present. */
  const findManagedSandboxRow = () =>
    db
      .select()
      .from(environments)
      .where(eq(environments.driver, "sandbox"))
      .then(
        (rows) =>
          rows.find(
            (row) =>
              (row.metadata as Record<string, unknown> | null)?.managedByPaperclip === true,
          ) ?? null,
      );

  /**
   * Idempotently ensure THE Paperclip-managed sandbox environment for this
   * instance, configured for an arbitrary sandbox provider plugin. Mirrors
   * `ensureLocalEnvironment`; the partial unique index
   * `environments_managed_sandbox_idx` enforces at most one managed sandbox
   * row per instance, so this function owns that single slot regardless of
   * provider:
   *
   * - An existing managed row is adopted and refreshed (name, description,
   *   config, provider) on every call, so operator/control-plane changes flow
   *   via redeploy without recreating the row — including a provider switch,
   *   which also drops a stale provider-specific metadata marker.
   * - An existing UNmanaged sandbox row holding the desired name is adopted
   *   and stamped as managed, so a row created by hand before the instance
   *   became config-managed converges instead of colliding on
   *   `environments_name_idx` on every boot.
   */
  const ensureManagedSandboxEnvironment = async (
    input: ManagedSandboxEnvironmentInput,
  ): Promise<Environment> => {
    const desiredConfig: Record<string, unknown> = {
      ...(input.config ?? {}),
      provider: input.provider,
    };
    const desiredMetadata: Record<string, unknown> = {
      managedByPaperclip: true,
      managedSandboxProvider: input.provider,
      ...(input.extraMetadata ?? {}),
    };

    const adopt = async (row: EnvironmentRow): Promise<Environment> => {
      const metadata: Record<string, unknown> = { ...(row.metadata ?? {}), ...desiredMetadata };
      // A provider switch must not leave the previous provider's marker
      // behind (`findKubernetesEnvironment` keys on it).
      if (desiredMetadata[KUBERNETES_MANAGED_MARKER] !== true) {
        delete metadata[KUBERNETES_MANAGED_MARKER];
      }
      const now = new Date();
      const runUpdate = (values: { name?: string }) =>
        db
          .update(environments)
          .set({
            ...values,
            // The row mirrors the managed spec: omitting `description` clears
            // a previously configured one rather than pinning it forever.
            description: input.description ?? null,
            config: desiredConfig,
            metadata,
            status: "active",
            updatedAt: now,
          })
          .where(eq(environments.id, row.id))
          .returning()
          .then((rows) => rows[0] ?? row);
      const updated = await runUpdate({ name: input.name }).catch((error: unknown) => {
        // Another row already holds the desired name; keep the current name
        // rather than failing a boot-time ensure over a display label.
        if (hasConstraintName(error, "environments_name_idx")) {
          return runUpdate({});
        }
        throw error;
      });
      return toEnvironment(updated);
    };

    const existing = await findManagedSandboxRow();
    if (existing) return adopt(existing);

    // The partial unique index `environments_managed_sandbox_idx` enforces
    // "at most one Paperclip-managed sandbox row per instance" at the DB
    // level. Use ON CONFLICT DO NOTHING keyed on that index so concurrent
    // callers can race the INSERT; losers re-read the surviving row.
    const now = new Date();
    const inserted = await db
      .insert(environments)
      .values({
        name: input.name,
        description: input.description ?? null,
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

    // Either a concurrent caller won the managed slot, or an unmanaged row
    // holds the desired name. Adopt whichever exists.
    const winner = await findManagedSandboxRow();
    if (winner) return adopt(winner);
    const sameName = await db
      .select()
      .from(environments)
      .where(eq(environments.name, input.name))
      .then((rows) => rows[0] ?? null);
    if (sameName) {
      if (sameName.driver !== "sandbox") {
        throw new Error(
          `Failed to ensure managed sandbox environment: environment "${input.name}" already exists with driver "${sameName.driver}"`,
        );
      }
      return adopt(sameName);
    }
    throw new Error("Failed to ensure managed sandbox environment");
  };

  /**
   * Archive the Paperclip-managed sandbox row when its provider became
   * unavailable (plugin missing, not ready, or its worker not running), so
   * run scheduling stops selecting an environment whose lease acquisition
   * cannot succeed (`resolveEnvironment` rejects non-active rows).
   *
   * Scoped to the row provisioned for the SAME provider: a row that a
   * provider switch left on a different provider is not touched (the ensure
   * path adopts it once the new provider is healthy). Reactivation is
   * automatic — the next successful `ensureManagedSandboxEnvironment` stamps
   * the row `active` again.
   *
   * Returns the archived environment, or null when there is no active
   * managed row for this provider.
   */
  const archiveManagedSandboxEnvironment = async (
    input: { provider: string },
  ): Promise<Environment | null> => {
    const existing = await findManagedSandboxRow();
    if (!existing || existing.status !== "active") return null;
    const rowProvider = (existing.metadata as Record<string, unknown> | null)
      ?.managedSandboxProvider;
    if (rowProvider !== input.provider) return null;
    const archived = await db
      .update(environments)
      .set({ status: "archived", updatedAt: new Date() })
      // Guarded on status so a concurrent re-activation is not clobbered.
      .where(and(eq(environments.id, existing.id), eq(environments.status, "active")))
      .returning()
      .then((rows) => rows[0] ?? null);
    return archived ? toEnvironment(archived) : null;
  };

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

    /**
     * Idempotently ensure THE local-driver environment row; the partial
     * unique index `environments_local_driver_idx` enforces at most one per
     * instance.
     *
     * On a cloud-managed instance an existing row is additionally ADOPTED —
     * stamped `managedByPaperclip: true` (other metadata preserved) — so the
     * single local slot is platform-owned there by construction, mirroring
     * `ensureManagedSandboxEnvironment`'s adoption of the sandbox slot. This
     * is what lets the environment-routes write floor treat a local row's
     * platform markers as live state rather than a stale leftover: every
     * caller (company creation, the heartbeat, run orchestration) converges
     * the marker. Self-hosted instances keep the historical behavior:
     * an existing row is returned untouched.
     */
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
      const existingMetadata = (existing.metadata ?? {}) as Record<string, unknown>;
      if (isCloudManagedInstance() && existingMetadata.managedByPaperclip !== true) {
        const adopted = await db
          .update(environments)
          .set({
            metadata: { ...existingMetadata, managedByPaperclip: true },
            updatedAt: new Date(),
          })
          .where(eq(environments.id, existing.id))
          .returning()
          .then((rows) => rows[0] ?? existing);
        return toEnvironment(adopted);
      }
      return toEnvironment(existing);
    },

    ensureManagedSandboxEnvironment,

    archiveManagedSandboxEnvironment,

    /**
     * Idempotently ensure a managed Kubernetes sandbox environment exists for
     * an instance, configured from instance/operator-supplied config. A thin
     * wrapper over `ensureManagedSandboxEnvironment` that pins the provider to
     * "kubernetes" and stamps the legacy marker `findKubernetesEnvironment`
     * keys on. On subsequent calls the config is refreshed (so operators can
     * update egress/runtimeClass via gitops without recreating the row).
     */
    ensureKubernetesEnvironment: async (
      companyIdOrConfig: string | KubernetesEnvironmentConfigInput,
      maybeConfig?: KubernetesEnvironmentConfigInput,
    ): Promise<Environment> => {
      const config = resolveKubernetesConfig(companyIdOrConfig, maybeConfig);
      return ensureManagedSandboxEnvironment({
        name: DEFAULT_KUBERNETES_ENVIRONMENT_NAME,
        description: DEFAULT_KUBERNETES_ENVIRONMENT_DESCRIPTION,
        provider: KUBERNETES_PROVIDER_KEY,
        config,
        extraMetadata: { [KUBERNETES_MANAGED_MARKER]: true },
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
      options?: { db?: EnvironmentWriteDb },
    ): Promise<Environment> => {
      const input = resolveCreateInput(companyIdOrInput, maybeInput);
      const now = new Date();
      const row = await (options?.db ?? db)
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

    update: async (
      id: string,
      patch: UpdateEnvironment,
      options?: { db?: EnvironmentWriteDb },
    ): Promise<Environment | null> => {
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

      const row = await (options?.db ?? db)
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
      const deleteBlockedReasons: EnvironmentDeleteBlockedReason[] = [];
      if (isManagedLocal) deleteBlockedReasons.push("managed_local");
      if (isInstanceDefault) deleteBlockedReasons.push("instance_default");
      const activeLeaseCount = countFromRows(activeLeaseRows);
      const activeCustomImageSetupSessionCount = countFromRows(activeSetupRows);

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
          hasActiveRuntimeUse: activeLeaseCount > 0 || activeCustomImageSetupSessionCount > 0,
        },
      };
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
