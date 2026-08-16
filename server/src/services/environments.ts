import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  builtInManagedResources,
  companies,
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
import { logActivity } from "./activity-log.js";
import { isCloudManagedInstance } from "./cloud-instance.js";
import {
  resourceStatus,
  stockHash,
  type ManagedResourceStockStatus,
} from "./managed-resource-drift.js";

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
  /** Company whose managed-resource binding should be reconciled. Omit at instance boot to bind every company. */
  companyId?: string;
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
  /** Version label recorded with the stock binding; hashes remain the drift authority. */
  stockVersion?: string;
}

export type ManagedSandboxEnvironmentReconcileAction =
  | "added"
  | "updated"
  | "unchanged"
  | "skipped";

export interface ManagedSandboxEnvironmentReconcileResult {
  environment: Environment;
  action: ManagedSandboxEnvironmentReconcileAction;
  /** Classification observed before this reconciliation wrote anything. */
  stockStatus: ManagedResourceStockStatus;
  /** True only when operator drift prevented the available stock update. */
  updateAvailable: boolean;
  stockHash: string;
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

const MANAGED_ENVIRONMENT_BUNDLE_KEY = "managed-sandbox-environment";
const MANAGED_ENVIRONMENT_RESOURCE_KIND = "environment";
const MANAGED_ENVIRONMENT_RESOURCE_KEY = "managed-sandbox";
const MANAGED_ENVIRONMENT_STOCK_VERSION = "managed-environment-v1";
const MANAGED_ENVIRONMENT_ARCHIVE_TOKEN_METADATA_KEY = "_paperclipManagedArchiveToken";
const MANAGED_ENVIRONMENT_ARCHIVE_TOKEN_DEFAULTS_KEY = "_paperclipManagedArchiveToken";

function managedEnvironmentBaselineDefaults(
  defaultsJson: Record<string, unknown>,
): Record<string, unknown> {
  const baseline = { ...defaultsJson };
  delete baseline[MANAGED_ENVIRONMENT_ARCHIVE_TOKEN_DEFAULTS_KEY];
  return baseline;
}

function withoutManagedEnvironmentArchiveToken(
  metadata: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!metadata) return null;
  const next = { ...metadata };
  delete next[MANAGED_ENVIRONMENT_ARCHIVE_TOKEN_METADATA_KEY];
  return next;
}

function managedMetadataKeys(
  desiredMetadata: Record<string, unknown>,
  bindings: Array<{ defaultsJson: Record<string, unknown> }>,
): string[] {
  const keys = new Set([
    "managedByPaperclip",
    "managedSandboxProvider",
    KUBERNETES_MANAGED_MARKER,
    ...Object.keys(desiredMetadata),
  ]);
  for (const binding of bindings) {
    const metadata = cloneRecord(binding.defaultsJson.metadata);
    for (const key of Object.keys(metadata ?? {})) keys.add(key);
  }
  return [...keys].sort((left, right) => left.localeCompare(right));
}

function managedEnvironmentStock(input: {
  name: string;
  description: string | null;
  config: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
  status: string;
}, metadataKeys: readonly string[]): Record<string, unknown> {
  const metadata = input.metadata ?? {};
  return {
    name: input.name,
    description: input.description,
    config: input.config,
    metadata: Object.fromEntries(
      metadataKeys.map((key) => [key, Object.prototype.hasOwnProperty.call(metadata, key) ? metadata[key] : null]),
    ),
    status: input.status,
  };
}

function mergeManagedEnvironmentMetadata(
  current: Record<string, unknown> | null,
  desired: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const merged = { ...(current ?? {}) };
  for (const key of keys) {
    const value = Object.prototype.hasOwnProperty.call(desired, key) ? desired[key] : null;
    if (value === null || value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

export function environmentService(db: Db) {
  /**
   * Idempotently ensure THE Paperclip-managed sandbox environment for this
   * instance, configured for an arbitrary sandbox provider plugin. Mirrors
   * `ensureLocalEnvironment`; the partial unique index
   * `environments_managed_sandbox_idx` enforces at most one managed sandbox
   * row per instance, so this function owns that single slot regardless of
   * provider:
   *
   * - A stock-controlled managed row advances to a new stock hash in the same
   *   transaction as its managed fields, including provider switches.
   * - A stock-current row is returned without an environment write.
   * - An operator-modified or previously unmanaged row is preserved and
   *   reported as skipped; its user-owned fields are never folded into stock.
   */
  const ensureManagedSandboxEnvironment = async (
    input: ManagedSandboxEnvironmentInput,
  ): Promise<ManagedSandboxEnvironmentReconcileResult> => {
    const desiredConfig: Record<string, unknown> = {
      ...(input.config ?? {}),
      provider: input.provider,
    };
    const desiredMetadata: Record<string, unknown> = {
      managedByPaperclip: true,
      managedSandboxProvider: input.provider,
      ...(input.extraMetadata ?? {}),
    };
    if (desiredMetadata[KUBERNETES_MANAGED_MARKER] !== true) {
      desiredMetadata[KUBERNETES_MANAGED_MARKER] = null;
    }

    let activityCompanyIds: string[] = [];
    let trackingInitialized = false;
    let providerReactivated = false;
    const reconciliation = await db.transaction(
      async (tx): Promise<ManagedSandboxEnvironmentReconcileResult> => {
        const companyIds = input.companyId
          ? [input.companyId]
          : await tx.select({ id: companies.id }).from(companies).then((rows) => rows.map((row) => row.id));
        activityCompanyIds = companyIds;
        const bindingConditions = and(
          eq(builtInManagedResources.bundleKey, MANAGED_ENVIRONMENT_BUNDLE_KEY),
          eq(builtInManagedResources.resourceKind, MANAGED_ENVIRONMENT_RESOURCE_KIND),
          eq(builtInManagedResources.resourceKey, MANAGED_ENVIRONMENT_RESOURCE_KEY),
          ...(companyIds.length > 0 ? [inArray(builtInManagedResources.companyId, companyIds)] : []),
        );
        const bindings = companyIds.length > 0
          ? await tx.select().from(builtInManagedResources).where(bindingConditions)
          : [];
        trackingInitialized = bindings.length < companyIds.length;
        const keys = managedMetadataKeys(desiredMetadata, bindings);

        const sandboxRows = await tx
          .select()
          .from(environments)
          .where(eq(environments.driver, "sandbox"))
          .for("update");
        let row = sandboxRows.find(
          (candidate) => (candidate.metadata as Record<string, unknown> | null)?.managedByPaperclip === true,
        ) ?? sandboxRows.find((candidate) => candidate.name === input.name) ?? null;

        const writeBindings = async (
          environmentId: string,
          stockVersion: string,
          installedStockHash: string,
          defaultsJson: Record<string, unknown>,
          replace: boolean,
        ) => {
          const targetCompanyIds = replace
            ? companyIds
            : companyIds.filter(
              (companyId) => !bindings.some((binding) => binding.companyId === companyId),
            );
          if (targetCompanyIds.length === 0) return;
          const values = targetCompanyIds.map((companyId) => ({
            companyId,
            bundleKey: MANAGED_ENVIRONMENT_BUNDLE_KEY,
            resourceKind: MANAGED_ENVIRONMENT_RESOURCE_KIND,
            resourceKey: MANAGED_ENVIRONMENT_RESOURCE_KEY,
            resourceId: environmentId,
            stockVersion,
            stockHash: installedStockHash,
            defaultsJson,
          }));
          const insert = tx.insert(builtInManagedResources).values(values);
          if (!replace) {
            await insert.onConflictDoNothing({
              target: [
                builtInManagedResources.companyId,
                builtInManagedResources.bundleKey,
                builtInManagedResources.resourceKind,
                builtInManagedResources.resourceKey,
              ],
            });
            return;
          }
          await insert.onConflictDoUpdate({
            target: [
              builtInManagedResources.companyId,
              builtInManagedResources.bundleKey,
              builtInManagedResources.resourceKind,
              builtInManagedResources.resourceKey,
            ],
            set: {
              resourceId: environmentId,
              stockVersion,
              stockHash: installedStockHash,
              defaultsJson,
              updatedAt: new Date(),
            },
          });
        };

        if (!row) {
          const nameOwner = await tx
            .select()
            .from(environments)
            .where(eq(environments.name, input.name))
            .then((rows) => rows[0] ?? null);
          if (nameOwner && nameOwner.driver !== "sandbox") {
            throw new Error(
              `Failed to ensure managed sandbox environment: environment "${input.name}" already exists with driver "${nameOwner.driver}"`,
            );
          }
          const now = new Date();
          const inserted = await tx
            .insert(environments)
            .values({
              name: input.name,
              description: input.description ?? null,
              driver: "sandbox",
              status: "active",
              config: desiredConfig,
              envVars: {},
              metadata: mergeManagedEnvironmentMetadata(null, desiredMetadata, keys),
              createdAt: now,
              updatedAt: now,
            })
            // Either the managed-slot partial index or the global name index
            // can select the concurrent winner. Treat both as convergence and
            // reselect that winner under lock below.
            .onConflictDoNothing()
            .returning()
            .then((rows) => rows[0] ?? null);
          if (inserted) {
            const stock = managedEnvironmentStock({
              name: inserted.name,
              description: inserted.description ?? null,
              config: inserted.config,
              metadata: inserted.metadata,
              status: inserted.status,
            }, keys);
            const latestStockHash = stockHash(stock);
            await writeBindings(
              inserted.id,
              input.stockVersion ?? MANAGED_ENVIRONMENT_STOCK_VERSION,
              latestStockHash,
              stock,
              true,
            );
            return {
              environment: toEnvironment(inserted),
              action: "added",
              stockStatus: "missing",
              updateAvailable: false,
              stockHash: latestStockHash,
            };
          }
          row = await tx
            .select()
            .from(environments)
            .where(eq(environments.driver, "sandbox"))
            .for("update")
            .then(
              (rows) => rows.find(
                (candidate) => (candidate.metadata as Record<string, unknown> | null)?.managedByPaperclip === true,
              ) ?? null,
            );
          if (!row) throw new Error("Failed to ensure managed sandbox environment");
        }

        const nameOwner = await tx
          .select({ id: environments.id })
          .from(environments)
          .where(eq(environments.name, input.name))
          .then((rows) => rows[0] ?? null);
        const desiredName = nameOwner && nameOwner.id !== row.id ? row.name : input.name;
        const desiredStock = managedEnvironmentStock({
          name: desiredName,
          description: input.description ?? null,
          config: desiredConfig,
          metadata: desiredMetadata,
          status: "active",
        }, keys);
        const latestStockHash = stockHash(desiredStock);
        const currentStock = managedEnvironmentStock({
          name: row.name,
          description: row.description ?? null,
          config: row.config,
          metadata: row.metadata,
          status: row.status,
        }, keys);
        const currentHash = stockHash(currentStock);
        const matchingBindings = bindings.filter((binding) => binding.resourceId === row!.id);
        const rowArchiveToken = (row.metadata as Record<string, unknown> | null)
          ?.[MANAGED_ENVIRONMENT_ARCHIVE_TOKEN_METADATA_KEY];
        let stockStatus = resourceStatus({
          resourceId: row.id,
          currentHash,
          bindingStockHash: matchingBindings[0]?.stockHash ?? null,
          latestStockHash,
        });
        if (stockStatus === "operator_modified") {
          const stockControlledBinding = matchingBindings.find(
            (binding) => resourceStatus({
              resourceId: row!.id,
              currentHash,
              bindingStockHash: binding.stockHash,
              latestStockHash,
            }) === "stock_update_available",
          );
          if (stockControlledBinding) stockStatus = "stock_update_available";
        }
        const operatorReaffirmedArchive = row.status === "archived" && matchingBindings.some(
          (binding) => {
            const bindingToken = binding.defaultsJson[MANAGED_ENVIRONMENT_ARCHIVE_TOKEN_DEFAULTS_KEY];
            return binding.defaultsJson.status === "archived" &&
              typeof bindingToken === "string" &&
              bindingToken !== rowArchiveToken;
          },
        );
        if (operatorReaffirmedArchive) stockStatus = "operator_modified";

        if (stockStatus === "operator_modified") {
          const baseline = matchingBindings[0];
          let baselineDefaults = baseline
            ? managedEnvironmentBaselineDefaults(baseline.defaultsJson)
            : desiredStock;
          let baselineHash = baseline?.stockHash ?? latestStockHash;

          // Provider unavailability is an operational state transition, not
          // an operator edit. If the binding records that Paperclip archived
          // this row, restore only its availability status. Keep every other
          // operator-modified field intact and leave the stock update pending.
          // A manually archived row still has an active binding baseline, so
          // it remains operator_modified and is not reactivated here.
          const archivedByReconciler = row.status === "archived" &&
            typeof rowArchiveToken === "string" &&
            matchingBindings.some((binding) => {
              const bindingDefaults = binding.defaultsJson;
              return bindingDefaults.status === "archived" &&
                bindingDefaults[MANAGED_ENVIRONMENT_ARCHIVE_TOKEN_DEFAULTS_KEY] === rowArchiveToken;
            });
          if (archivedByReconciler) {
            const reactivated = await tx
              .update(environments)
              .set({
                status: "active",
                metadata: withoutManagedEnvironmentArchiveToken(row.metadata),
                updatedAt: new Date(),
              })
              .where(and(eq(environments.id, row.id), eq(environments.status, "archived")))
              .returning()
              .then((rows) => rows[0] ?? null);
            if (!reactivated) {
              throw new Error("Managed sandbox environment changed during reactivation");
            }
            row = reactivated;
            providerReactivated = true;

            for (const binding of matchingBindings) {
              const reactivatedDefaults = {
                ...managedEnvironmentBaselineDefaults(binding.defaultsJson),
                status: "active",
              };
              const reactivatedHash = stockHash(reactivatedDefaults);
              await tx
                .update(builtInManagedResources)
                .set({
                  stockHash: reactivatedHash,
                  defaultsJson: reactivatedDefaults,
                  updatedAt: new Date(),
                })
                .where(and(
                  eq(builtInManagedResources.id, binding.id),
                  eq(builtInManagedResources.resourceId, row.id),
                ));
              if (binding.id === baseline?.id) {
                baselineDefaults = reactivatedDefaults;
                baselineHash = reactivatedHash;
              }
            }
          }
          await writeBindings(
            row.id,
            baseline?.stockVersion ?? input.stockVersion ?? MANAGED_ENVIRONMENT_STOCK_VERSION,
            baselineHash,
            baselineDefaults,
            false,
          );
          return {
            environment: toEnvironment(row),
            action: "skipped",
            stockStatus,
            updateAvailable: true,
            stockHash: latestStockHash,
          };
        }

        if (stockStatus === "stock_current") {
          await writeBindings(
            row.id,
            input.stockVersion ?? MANAGED_ENVIRONMENT_STOCK_VERSION,
            latestStockHash,
            desiredStock,
            false,
          );
          return {
            environment: toEnvironment(row),
            action: "unchanged",
            stockStatus,
            updateAvailable: false,
            stockHash: latestStockHash,
          };
        }

        const updated = await tx
          .update(environments)
          .set({
            name: desiredName,
            description: input.description ?? null,
            config: desiredConfig,
            metadata: withoutManagedEnvironmentArchiveToken(
              mergeManagedEnvironmentMetadata(row.metadata, desiredMetadata, keys),
            ),
            status: "active",
            updatedAt: new Date(),
          })
          .where(eq(environments.id, row.id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) throw new Error("Managed sandbox environment changed during reconciliation");
        await writeBindings(
          updated.id,
          input.stockVersion ?? MANAGED_ENVIRONMENT_STOCK_VERSION,
          latestStockHash,
          desiredStock,
          true,
        );
        return {
          environment: toEnvironment(updated),
          action: "updated",
          stockStatus,
          updateAvailable: false,
          stockHash: latestStockHash,
        };
      },
    );
    if (reconciliation.action !== "unchanged" || trackingInitialized) {
      const action = reconciliation.action === "added"
        ? "environment.managed_stock_added"
        : reconciliation.action === "updated"
          ? "environment.managed_stock_updated"
          : reconciliation.action === "skipped"
            ? "environment.managed_stock_skipped"
            : "environment.managed_stock_tracking_initialized";
      await Promise.all(activityCompanyIds.map((companyId) => logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "managed-environment-reconciler",
        action,
        entityType: "environment",
        entityId: reconciliation.environment.id,
        details: {
          provider: input.provider,
          reconciliationAction: reconciliation.action,
          stockStatus: reconciliation.stockStatus,
          updateAvailable: reconciliation.updateAvailable,
          stockHash: reconciliation.stockHash,
          providerReactivated,
        },
      })));
    }
    return reconciliation;
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
    input: { provider: string; companyId?: string },
  ): Promise<Environment | null> => {
    let activityCompanyIds: string[] = [];
    const archived = await db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(environments)
        .where(eq(environments.driver, "sandbox"))
        .for("update")
        .then(
          (rows) => rows.find(
            (row) => (row.metadata as Record<string, unknown> | null)?.managedByPaperclip === true,
          ) ?? null,
        );
      if (!existing || existing.status !== "active") return null;
      const rowProvider = (existing.metadata as Record<string, unknown> | null)
        ?.managedSandboxProvider;
      if (rowProvider !== input.provider) return null;

      const companyIds = input.companyId
        ? [input.companyId]
        : await tx.select({ id: companies.id }).from(companies).then((rows) => rows.map((row) => row.id));
      activityCompanyIds = companyIds;
      const bindings = companyIds.length > 0
        ? await tx
          .select()
          .from(builtInManagedResources)
          .where(and(
            inArray(builtInManagedResources.companyId, companyIds),
            eq(builtInManagedResources.bundleKey, MANAGED_ENVIRONMENT_BUNDLE_KEY),
            eq(builtInManagedResources.resourceKind, MANAGED_ENVIRONMENT_RESOURCE_KIND),
            eq(builtInManagedResources.resourceKey, MANAGED_ENVIRONMENT_RESOURCE_KEY),
            eq(builtInManagedResources.resourceId, existing.id),
          ))
        : [];
      const archiveToken = randomUUID();
      const archivedMetadata = {
        ...(existing.metadata ?? {}),
        [MANAGED_ENVIRONMENT_ARCHIVE_TOKEN_METADATA_KEY]: archiveToken,
      };
      const archived = await tx
        .update(environments)
        .set({
          status: "archived",
          metadata: archivedMetadata,
          updatedAt: new Date(),
        })
        .where(and(eq(environments.id, existing.id), eq(environments.status, "active")))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!archived) return null;

      // Archival is a Paperclip-owned availability transition. Record only
      // that status change in each installed baseline. Deriving the new hash
      // from defaultsJson keeps operator-modified row fields out of stock.
      for (const binding of bindings) {
        const archivedStock = {
          ...managedEnvironmentBaselineDefaults(binding.defaultsJson),
          status: "archived",
        };
        await tx
          .update(builtInManagedResources)
          .set({
            stockHash: stockHash(archivedStock),
            defaultsJson: {
              ...archivedStock,
              [MANAGED_ENVIRONMENT_ARCHIVE_TOKEN_DEFAULTS_KEY]: archiveToken,
            },
            updatedAt: new Date(),
          })
          .where(and(
            eq(builtInManagedResources.id, binding.id),
            eq(builtInManagedResources.resourceId, existing.id),
          ));
      }
      return toEnvironment(archived);
    });
    if (archived) {
      await Promise.all(activityCompanyIds.map((companyId) => logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "managed-environment-reconciler",
        action: "environment.managed_provider_unavailable_archived",
        entityType: "environment",
        entityId: archived.id,
        details: { provider: input.provider },
      })));
    }
    return archived;
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
     * keys on. On subsequent calls stock-controlled config advances in place;
     * operator modifications remain untouched for explicit review.
     */
    ensureKubernetesEnvironment: async (
      companyIdOrConfig: string | KubernetesEnvironmentConfigInput,
      maybeConfig?: KubernetesEnvironmentConfigInput,
    ): Promise<Environment> => {
      const config = resolveKubernetesConfig(companyIdOrConfig, maybeConfig);
      return ensureManagedSandboxEnvironment({
        companyId: typeof companyIdOrConfig === "string" ? companyIdOrConfig : undefined,
        name: DEFAULT_KUBERNETES_ENVIRONMENT_NAME,
        description: DEFAULT_KUBERNETES_ENVIRONMENT_DESCRIPTION,
        provider: KUBERNETES_PROVIDER_KEY,
        config,
        extraMetadata: { [KUBERNETES_MANAGED_MARKER]: true },
      }).then((result) => result.environment);
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

    /**
     * Find the platform-managed sandbox environment (the single
     * `managedByPaperclip`-marked slot row), if one exists. Read-only
     * counterpart to `ensureManagedSandboxEnvironment`. The default
     * (active-only) form serves the managed-sandbox-only run guard — which
     * must fail closed rather than create a config-less environment when
     * the slot is empty or archived (the provisioner archives it while its
     * provider plugin is down). `includeArchived` serves reconciliation
     * cleanup, which must find the row even after the provisioner archived
     * it.
     */
    findManagedSandboxEnvironment: async (
      _companyId?: string,
      options?: { includeArchived?: boolean },
    ): Promise<Environment | null> => {
      const rows = await db
        .select()
        .from(environments)
        .where(
          options?.includeArchived === true
            ? eq(environments.driver, "sandbox")
            : and(
                eq(environments.driver, "sandbox"),
                eq(environments.status, "active"),
              ),
        )
        .orderBy(desc(environments.updatedAt));
      const match = rows.find(
        (row) => (row.metadata as Record<string, unknown> | null)?.managedByPaperclip === true,
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
      const writeDb = options?.db ?? db;
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
      if (patch.metadata !== undefined) {
        values.metadata = withoutManagedEnvironmentArchiveToken(patch.metadata ?? null);
      } else if (patch.status !== undefined) {
        const existingMetadata = await writeDb
          .select({ metadata: environments.metadata })
          .from(environments)
          .where(eq(environments.id, id))
          .then((rows) => rows[0]?.metadata ?? null);
        values.metadata = withoutManagedEnvironmentArchiveToken(existingMetadata);
      }

      const row = await writeDb
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
