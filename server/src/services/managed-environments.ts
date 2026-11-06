/**
 * Managed-environment bootstrap (harness → app contract).
 *
 * Managed-cloud instances may declare sandbox environments in the
 * `environments` section of `PAPERCLIP_MANAGED_CONFIG` (parsed fail-closed in
 * `managed-config.ts`). On boot, each declared environment is idempotently
 * ensured as the instance-level Paperclip-managed sandbox row via the
 * provider-agnostic `ensureManagedSandboxEnvironment` — the control plane
 * provisions, tenants use, for any bundled sandbox provider plugin.
 *
 * The failure posture mirrors bundled plugin provisioning
 * (`bundled-plugins.ts`), deliberately split:
 *
 * 1. **Validation fails closed at parse time** (`managed-config.ts`): a
 *    malformed section refuses startup with a precise error.
 * 2. **The DB ensure step is fail-safe per entry**: an ensure failure is
 *    logged and boot continues degraded (environment unavailable) rather
 *    than crash-looping a fleet.
 *
 * Ensuring is additionally synchronized with provider availability: the
 * caller's `pluginsReady` promise (the bundled-plugin install/load pass) is
 * awaited first, and an entry whose provider plugin is not installed, `ready`,
 * AND running a live worker (`workerManager.isRunning`; a `ready` record whose
 * activation failed has no worker and cannot serve leases) afterwards is
 * skipped (counted failed) instead of being written as an active row —
 * otherwise the heartbeat would resume queued runs against an environment
 * whose lease acquisition cannot succeed yet. When such an entry was
 * provisioned by an earlier boot, its still-active row is archived
 * (`archiveManagedSandboxEnvironment`) for the same reason. Re-activation
 * happens on the next healthy boot's ensure, or earlier: when the plugin
 * record is `ready` and only the worker is down (a crash in restart-backoff),
 * a one-shot `ready` listener on the worker handle re-runs the ensure as soon
 * as the worker manager respawns the worker, so a transient crash does not
 * leave the environment archived until someone restarts the server.
 *
 * Removing an entry from the document stops future refreshes but never
 * deletes or archives the row — there is intentionally no unprovision path
 * here, matching `plugins.autoInstall` semantics (leases may still reference
 * the row; withdrawal is an explicit operator action). Archiving above is
 * scoped to a declared-but-unavailable provider, not to document removal.
 *
 * Provider credentials are never part of the declared config: every bundled
 * sandbox provider falls back to its documented process environment variable
 * (e.g. `DAYTONA_API_KEY`) when `config` omits the key, so the deployment
 * delivers secrets as env vars and the managed document stays secret-free.
 *
 * `driver: "plugin"` entries take the same readiness path after the sandbox
 * entry: await `pluginsReady`, require the plugin `ready`, declaring the
 * entry's driver, and running a worker; else archive the entry's row and
 * re-ensure it on the worker's `ready`. Each entry owns one row (see
 * `managed-plugin-environments.ts`). This pass never decides the instance
 * default: one plugin entry may carry `instanceDefault`, and the retry
 * worker (`registerManagedPluginInstanceDefaultRetry`, registered after this
 * pass) is the only owner of that one-time decision. The sandbox stamp below
 * only fills an unset or local default and only reverts its own stamped
 * default, so it never replaces or reverts a plugin default.
 */

import type { Db } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { environmentService } from "./environments.js";
import type { ManagedSandboxEnvironmentReconcileAction } from "./environments.js";
import { instanceSettingsService } from "./instance-settings.js";
import type { ManagedInstanceConfig } from "./managed-config.js";
import type { ManagedResourceStockStatus } from "./managed-resource-drift.js";
import { parseExecutionPolicyBootstrapEnv } from "./execution-policy-bootstrap.js";
import { resolvePluginSandboxProviderDriverByKey } from "./plugin-environment-driver.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { trackIdleWork } from "./task-admission.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { resolveBundledCatalogRoot, resolveBundledPluginInstalls } from "./bundled-plugins.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import {
  applyManagedPluginInstanceDefault,
  readManagedEnvironmentDefaultDecision,
} from "./managed-environment-default.js";
import {
  managedPluginEnvironmentMarker,
  type ManagedPluginEnvironmentReconcileAction,
} from "./managed-plugin-environments.js";

/**
 * Lifecycle of the recovery work `applyManagedEnvironments` leaves behind
 * after boot (re-ensuring an archived environment when its plugin worker
 * becomes ready).
 */
export interface ManagedEnvironmentRecovery {
  /** Run one attempt as idle-tracked work, unless stopped. */
  run(work: () => Promise<void>): void;
  /** Register an unsubscribe function for `stop()`. Calls it at once when stopped. */
  onStop(unsubscribe: () => void): void;
  /** Unsubscribe every listener, refuse new attempts, and await unfinished ones. */
  stop(): Promise<void>;
}

export function createManagedEnvironmentRecovery(): ManagedEnvironmentRecovery {
  const inFlight = new Set<Promise<void>>();
  const unsubscribers = new Set<() => void>();
  let stopped = false;
  return {
    run(work) {
      if (stopped) return;
      const attempt: Promise<void> = trackIdleWork(work())
        .catch(() => undefined)
        .finally(() => { inFlight.delete(attempt); });
      inFlight.add(attempt);
    },
    onStop(unsubscribe) {
      if (stopped) unsubscribe();
      else unsubscribers.add(unsubscribe);
    },
    async stop() {
      stopped = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
      unsubscribers.clear();
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}

export interface ApplyManagedEnvironmentsOptions {
  env?: Record<string, string | undefined>;
  /**
   * Resolves when the bundled-plugin startup pass (install + load; the
   * `ensureBundledPlugins` chain in `createApp`) has finished. Awaited before
   * any environment is ensured so an active row never precedes its provider
   * driver. The promise never rejects (the chain catches internally).
   */
  pluginsReady?: Promise<unknown>;
  /**
   * The app's plugin worker manager, consulted per entry so an environment is
   * only ensured while its provider plugin has a live worker (a `ready`
   * registry record whose activation failed cannot serve leases). Fails
   * closed: without a worker manager every entry is treated as unavailable.
   *
   * `getWorker` is `PluginWorkerManager.getWorker` narrowed to the `ready`
   * subscription used for post-archive recovery: a worker in crash-restart
   * backoff re-emits `ready` when the manager respawns it, and the listener
   * re-ensures the archived environment (see `applyManagedEnvironments`).
   *
   * Plugin entries also need `call`, to run the plugin's own config
   * validation; without it every plugin entry is treated as unavailable.
   */
  workerManager?: Pick<PluginWorkerManager, "isRunning"> & Partial<Pick<PluginWorkerManager, "call" | "onWorkerReady">> & {
    getWorker(pluginId: string):
      | {
          on(event: "ready", listener: (payload: { pluginId: string }) => void): void;
          off(event: "ready", listener: (payload: { pluginId: string }) => void): void;
        }
      | undefined;
  };
  /** Test seam: overrides the environment service built from `db`. */
  environments?: Pick<
    ReturnType<typeof environmentService>,
    | "ensureManagedSandboxEnvironment"
    | "archiveManagedSandboxEnvironment"
    | "getById"
    | "update"
    | "findManagedSandboxEnvironment"
    | "ensureManagedPluginEnvironment"
    | "archiveManagedPluginEnvironment"
    | "findManagedPluginEnvironment"
  >;
  /** Test seam: overrides the instance-settings service built from `db`. */
  instanceSettings?: Pick<ReturnType<typeof instanceSettingsService>, "get" | "update">;
  /** Test seam: overrides the sandbox-provider plugin driver lookup. */
  resolveSandboxProviderDriver?: (input: {
    db: Db;
    driverKey: string;
  }) => Promise<{ plugin: { id: string; pluginKey: string; status: string } } | null>;
  /**
   * Test seam: overrides the lookup of a plugin entry's plugin. Returns null
   * when the plugin is not installed; `declaresDriver` is false when its
   * manifest does not declare the entry's environment driver.
   */
  resolveEnvironmentPlugin?: (input: {
    db: Db;
    pluginKey: string;
    driverKey: string;
  }) => Promise<{ plugin: { id: string; pluginKey: string; status: string }; declaresDriver: boolean } | null>;
  /**
   * Manifest ids (`pluginKey`) that the `plugins.autoInstall` catalog keys
   * resolve to: `app.locals.managedBundledPluginKeys`, from
   * `resolveBundledPluginInstalls` over the bundled and distribution
   * catalogs. A plugin entry whose `pluginKey` is not in this list refuses
   * startup. When omitted, the list is resolved here the same way.
   */
  autoInstalledPluginKeys?: readonly string[];
  /**
   * Owns the post-boot recovery attempts and their `ready` subscriptions:
   * each attempt counts as idle-tracked work, and `stop()` (called on
   * shutdown before the database closes) unsubscribes and awaits unfinished
   * attempts. Defaults to a controller nobody stops (tests).
   */
  recovery?: ManagedEnvironmentRecovery;
}

export interface ManagedPluginEnvironmentReconciliationOutcome {
  environmentId: string;
  name: string;
  pluginKey: string;
  driverKey: string;
  action: ManagedPluginEnvironmentReconcileAction;
}

export interface ManagedEnvironmentReconciliationOutcome {
  environmentId: string;
  name: string;
  provider: string;
  action: ManagedSandboxEnvironmentReconcileAction;
  stockStatus: ManagedResourceStockStatus;
  updateAvailable: boolean;
}

export interface ApplyManagedEnvironmentsResult {
  ensured: number;
  failed: number;
  added: number;
  updated: number;
  unchanged: number;
  skipped: number;
  /** Managed reconciliation never removes rows in preserve-only mode. */
  removed: number;
  /** Preserve-only reconciliation never creates replacement backups. */
  backedUp: number;
  outcomes: ManagedEnvironmentReconciliationOutcome[];
  pluginOutcomes: ManagedPluginEnvironmentReconciliationOutcome[];
}

/**
 * The plugin refused the entry's config (`HttpError` 422 from
 * `normalizeEnvironmentConfig` or `validatePluginEnvironmentDriverConfig`).
 * Retrying cannot help until the config changes. Every other failure, such
 * as a worker that crashed mid-call, is treated as transient.
 */
function isPermanentConfigRejection(err: unknown): boolean {
  return err instanceof HttpError && err.status === 422;
}

async function resolveEnvironmentPluginByKey(input: { db: Db; pluginKey: string; driverKey: string }) {
  const plugin = await pluginRegistryService(input.db).getByKey(input.pluginKey);
  if (!plugin) return null;
  return {
    plugin: { id: plugin.id, pluginKey: plugin.pluginKey, status: plugin.status },
    declaresDriver: plugin.manifestJson.environmentDrivers?.some(
      (driver) => driver.driverKey === input.driverKey && driver.kind !== "sandbox_provider",
    ) ?? false,
  };
}

/**
 * Ensure every environment declared in the managed-config document. Returns
 * null when there is nothing to do (self-hosted, or no `environments`
 * section); otherwise the ensured/failed counts. Idempotent; safe to call on
 * every boot.
 */
export async function applyManagedEnvironments(
  db: Db,
  managedConfig: ManagedInstanceConfig | null,
  opts: ApplyManagedEnvironmentsOptions = {},
): Promise<ApplyManagedEnvironmentsResult | null> {
  if (!managedConfig) return null;

  const settings = opts.instanceSettings ?? instanceSettingsService(db);
  const environments = opts.environments ?? environmentService(db);
  const managedSandboxOnlyDeclared = managedConfig.features.enableManagedSandboxOnly === true;

  // Mode-off default cleanup runs BEFORE any ensure, and regardless of
  // whether the document still declares environments or the provider is
  // available: a reconciliation-stamped default must not outlive the mode
  // through the paths that skip per-entry reconciliation entirely — the
  // declaration was removed, the provider is down, or the row was
  // archived. Only a default that points at the managed row AND carries
  // the `managedDefaultStamped` marker reverts; tenant-chosen defaults
  // (no marker) are untouched.
  if (!managedSandboxOnlyDeclared) {
    try {
      const managedRow = await environments.findManagedSandboxEnvironment(undefined, {
        includeArchived: true,
      });
      if (
        managedRow &&
        managedRow.metadata?.managedDefaultStamped === true &&
        ((await settings.get()).defaultEnvironmentId ?? null) === managedRow.id
      ) {
        await settings.update({ defaultEnvironmentId: null });
        const { managedDefaultStamped: _cleared, ...remainingMetadata } = managedRow.metadata ?? {};
        await environments.update(managedRow.id, { metadata: remainingMetadata });
        logger.info(
          { environmentId: managedRow.id },
          "instance default environment reverted from the managed sandbox environment (managed-sandbox-only is not declared)",
        );
      }
    } catch (err) {
      logger.error(
        { err },
        "failed to revert the stamped managed sandbox instance default (degraded: stale default until the next boot)",
      );
    }
  }

  const pluginSpecs = managedConfig.pluginEnvironments;
  if (managedConfig.environments.length === 0 && pluginSpecs.length === 0) return null;

  // The forced-execution-mode bootstrap (`PAPERCLIP_EXECUTION_MODE=kubernetes`)
  // and this one both own the single Paperclip-managed sandbox row
  // (`environments_managed_sandbox_idx`). Configuring both is contradictory;
  // refuse startup rather than let bootstrap ordering pick a winner. Plugin
  // entries do not touch that slot.
  const env = opts.env ?? process.env;
  if (managedConfig.environments.length > 0 && parseExecutionPolicyBootstrapEnv(env)) {
    throw new Error(
      `PAPERCLIP_EXECUTION_MODE and the PAPERCLIP_MANAGED_CONFIG "environments" section are mutually exclusive: both manage the single instance sandbox environment`,
    );
  }

  // Coherence, fail closed like the parser: a plugin entry names its plugin by
  // manifest id, and only `plugins.autoInstall` provisions plugins on a
  // managed instance, so some auto-installed catalog entry must install it.
  if (pluginSpecs.length > 0) {
    const autoInstalledPluginKeys = opts.autoInstalledPluginKeys ?? resolveBundledPluginInstalls(
      managedConfig.plugins.autoInstall,
      { catalogRoot: resolveBundledCatalogRoot(env), env, enforceCatalogRoot: true },
    ).map((install) => install.pluginKey);
    for (const spec of pluginSpecs) {
      if (!autoInstalledPluginKeys.includes(spec.pluginKey)) {
        throw new Error(
          `PAPERCLIP_MANAGED_CONFIG "environments" entry "${spec.name}" uses plugin "${spec.pluginKey}", which no "plugins.autoInstall" catalog entry installs; a managed plugin environment requires its plugin to be provisioned`,
        );
      }
    }
  }

  // The heartbeat resumes queued runs right after this bootstrap step, and
  // lease acquisition fails hard on a provider whose plugin is missing or not
  // ready. Wait for the bundled-plugin startup pass to finish, then refuse to
  // ensure (and in particular to re-activate) a row whose provider driver did
  // not come up — a degraded boot without the row beats an active environment
  // that fails every lease until the plugin recovers.
  await opts.pluginsReady;

  const resolveDriver = opts.resolveSandboxProviderDriver ?? resolvePluginSandboxProviderDriverByKey;

  /**
   * Point the instance default at the managed sandbox row when no
   * deliberate choice stands in the way: an unset default, a default on
   * the (hidden-under-this-mode) local row, or a dangling reference all
   * move to the managed environment, so pickers and run selection agree
   * that "the default" is the platform sandbox. A tenant-chosen custom
   * environment (ssh, their own sandbox) is never overridden.
   *
   * Gated symmetrically on the document declaring
   * `enableManagedSandboxOnly`:
   *
   * - Declared: stamp the managed row as the default, so pickers and run
   *   selection agree the platform sandbox is "the default". The stamp is
   *   recorded as `managedDefaultStamped` in the row's platform-owned
   *   metadata (which boot reconciliation preserves and the client write
   *   floor protects), so a stamped default is distinguishable from one
   *   the tenant chose deliberately.
   * - Not declared: local execution is a legitimate default again, so a
   *   default THIS reconciliation stamped earlier (points at the managed
   *   row AND carries the stamp marker) reverts to unset — otherwise
   *   turning the mode off would keep routing default-following runs
   *   into the sandbox off a stale stamp. A default the tenant selected
   *   themselves — the managed row without the marker, or any custom
   *   environment — is untouched in both directions.
   *
   * Idempotent and best-effort — a failure degrades to the run-time
   * policy, which refuses local under managed-sandbox-only regardless.
   */
  const ensureManagedInstanceDefault = async (managedEnvironment: {
    id: string;
    metadata: Record<string, unknown> | null;
  }): Promise<void> => {
    if (!managedSandboxOnlyDeclared) return;
    try {
      const current = (await settings.get()).defaultEnvironmentId ?? null;
      if (current === managedEnvironment.id) return;
      if (current !== null) {
        const currentEnvironment = await environments.getById(current);
        if (currentEnvironment && currentEnvironment.driver !== "local") return;
      }
      // Marker first: a crash between the two writes must never leave a
      // stamped default that the revert path cannot attribute.
      await environments.update(managedEnvironment.id, {
        metadata: { ...(managedEnvironment.metadata ?? {}), managedDefaultStamped: true },
      });
      await settings.update({ defaultEnvironmentId: managedEnvironment.id });
      logger.info(
        { environmentId: managedEnvironment.id, previousDefaultEnvironmentId: current },
        "instance default environment set to the managed sandbox environment",
      );
    } catch (err) {
      logger.error(
        { err, environmentId: managedEnvironment.id },
        "failed to reconcile the instance default environment with the managed sandbox environment",
      );
    }
  };

  // Recovery path for a `ready` plugin whose worker was down at check time:
  // that shape is usually a crash in restart-backoff, and the manager
  // re-emits `ready` when it respawns or replaces the worker. A one-shot
  // listener re-runs the idempotent ensure so the recovered provider becomes
  // selectable again without waiting for the next boot (this pass has already
  // archived the row). The post-subscribe `isRunning` re-check closes the race
  // where the worker recovered between the gate check and the subscription.
  // Each attempt runs through `recovery`, so idle checks count it and shutdown
  // awaits it.
  const recovery = opts.recovery ?? createManagedEnvironmentRecovery();

  /**
   * Call `listener` on each `ready` of the plugin's worker. Prefers the
   * manager-wide subscription, which survives a restart replacing the worker
   * handle (for example a settings save that restarts the worker). Returns
   * the unsubscribe function, or null when there is no way to hear a `ready`
   * (no manager-wide subscription and no handle: activation never started a
   * worker, so no respawn is coming).
   */
  const subscribeWorkerReady = (pluginId: string, listener: () => void): (() => void) | null => {
    const manager = opts.workerManager;
    if (manager?.onWorkerReady) {
      return manager.onWorkerReady((readyPluginId) => {
        if (readyPluginId === pluginId) listener();
      });
    }
    const handle = manager?.getWorker(pluginId);
    if (!handle) return null;
    handle.on("ready", listener);
    return () => handle.off("ready", listener);
  };

  const scheduleRecoveryReactivation = (pluginId: string, reactivateEntry: () => Promise<void>): void => {
    let reactivated = false;
    let unsubscribe: (() => void) | null = null;
    const reactivate = (): void => {
      if (reactivated) return;
      reactivated = true;
      unsubscribe?.();
      recovery.run(reactivateEntry);
    };
    unsubscribe = subscribeWorkerReady(pluginId, reactivate);
    if (!unsubscribe) return;
    recovery.onStop(unsubscribe);
    if (opts.workerManager?.isRunning(pluginId)) reactivate();
  };

  const reactivateSandboxEntry = async (spec: ManagedInstanceConfig["environments"][number]): Promise<void> => {
    try {
      const result = await environments.ensureManagedSandboxEnvironment({
        name: spec.name,
        description: spec.description,
        provider: spec.provider,
        config: { ...spec.config },
        stockVersion: managedConfig.catalogVersion,
        platformFullyManaged: true,
      });
      logger.info(
        {
          environmentId: result.environment.id,
          name: spec.name,
          provider: spec.provider,
          action: result.action,
          stockStatus: result.stockStatus,
          updateAvailable: result.updateAvailable,
        },
        "managed sandbox environment reactivated after provider worker recovery",
      );
    } catch (err) {
      logger.error(
        { err, name: spec.name, provider: spec.provider },
        "failed to reactivate managed sandbox environment after provider worker recovery (degraded: environment unavailable until next boot)",
      );
    }
  };

  let ensured = 0;
  let failed = 0;
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  const outcomes: ManagedEnvironmentReconciliationOutcome[] = [];
  for (const spec of managedConfig.environments) {
    try {
      const resolved = await resolveDriver({ db, driverKey: spec.provider });
      // `ready` in the registry is necessary but not sufficient: activation
      // can fail after install leaves the record `ready`, in which case no
      // worker is running and the driver cannot serve leases.
      const workerRunning =
        resolved != null && (opts.workerManager?.isRunning(resolved.plugin.id) ?? false);
      if (!resolved || resolved.plugin.status !== "ready" || !workerRunning) {
        failed += 1;
        // A row provisioned by an earlier boot must not stay active either —
        // archive it so run scheduling stops selecting it. Best-effort: an
        // archive failure is logged, and the entry is already counted failed.
        const archived = await environments
          .archiveManagedSandboxEnvironment({ provider: spec.provider })
          .catch((archiveErr: unknown) => {
            logger.error(
              { err: archiveErr, name: spec.name, provider: spec.provider },
              "failed to archive the managed sandbox environment of an unavailable provider",
            );
            return null;
          });
        logger.error(
          {
            name: spec.name,
            provider: spec.provider,
            pluginKey: resolved?.plugin.pluginKey ?? null,
            pluginStatus: resolved?.plugin.status ?? null,
            workerRunning,
            archivedEnvironmentId: archived?.id ?? null,
          },
          "managed sandbox environment provider plugin is not installed, ready, and running; skipping ensure and archiving any previously provisioned row (degraded: environment unavailable)",
        );
        // Only a `ready` record can recover without another boot: the worker
        // manager restarts crashed workers, but nothing (re)installs a missing
        // or non-ready plugin at runtime.
        if (resolved && resolved.plugin.status === "ready") {
          scheduleRecoveryReactivation(resolved.plugin.id, () => reactivateSandboxEntry(spec));
        }
        continue;
      }
      const reconciliation = await environments.ensureManagedSandboxEnvironment({
        name: spec.name,
        description: spec.description,
        provider: spec.provider,
        config: { ...spec.config },
        stockVersion: managedConfig.catalogVersion,
        platformFullyManaged: true,
      });
      if (reconciliation.action === "skipped") skipped += 1;
      else {
        ensured += 1;
        if (reconciliation.action === "added") added += 1;
        else if (reconciliation.action === "updated") updated += 1;
        else unchanged += 1;
      }
      outcomes.push({
        environmentId: reconciliation.environment.id,
        name: reconciliation.environment.name,
        provider: spec.provider,
        action: reconciliation.action,
        stockStatus: reconciliation.stockStatus,
        updateAvailable: reconciliation.updateAvailable,
      });
      await ensureManagedInstanceDefault(reconciliation.environment);
      const logContext = {
        environmentId: reconciliation.environment.id,
        name: reconciliation.environment.name,
        provider: spec.provider,
        action: reconciliation.action,
        stockStatus: reconciliation.stockStatus,
        updateAvailable: reconciliation.updateAvailable,
      };
      if (reconciliation.action === "skipped") {
        logger.warn(
          logContext,
          "managed sandbox environment has operator modifications; preserving row and skipping stock update",
        );
      } else {
        logger.info(logContext, "managed sandbox environment reconciled");
      }
    } catch (err) {
      failed += 1;
      logger.error(
        { err, name: spec.name, provider: spec.provider },
        "failed to ensure managed sandbox environment; continuing boot (degraded: environment unavailable)",
      );
    }
  }
  // Plugin entries never decide the instance default here: the retry worker
  // registered after this pass is its only owner (see
  // `registerManagedPluginInstanceDefaultRetry`).
  const resolvePlugin = opts.resolveEnvironmentPlugin ?? resolveEnvironmentPluginByKey;
  const pluginOutcomes: ManagedPluginEnvironmentReconciliationOutcome[] = [];

  const ensurePluginEntry = (
    spec: ManagedInstanceConfig["pluginEnvironments"][number],
    workerManager: Pick<PluginWorkerManager, "isRunning" | "call">,
  ) =>
    environments.ensureManagedPluginEnvironment({
      name: spec.name,
      description: spec.description,
      pluginKey: spec.pluginKey,
      driverKey: spec.driverKey,
      driverConfig: { ...spec.driverConfig },
      workerManager,
    });

  type PluginSpec = ManagedInstanceConfig["pluginEnvironments"][number];
  type PluginWorkerAccess = Pick<PluginWorkerManager, "isRunning" | "call">;

  const archivePluginEntry = (spec: PluginSpec) =>
    environments
      .archiveManagedPluginEnvironment({ pluginKey: spec.pluginKey, driverKey: spec.driverKey })
      .catch((archiveErr: unknown) => {
        logger.error(
          { err: archiveErr, name: spec.name, pluginKey: spec.pluginKey, driverKey: spec.driverKey },
          "failed to archive the managed plugin environment of an unavailable plugin",
        );
        return null;
      });

  /**
   * Re-ensure a plugin entry each time its worker reports `ready`, until one
   * ensure succeeds or the plugin permanently rejects the entry's config. A
   * worker that crashes during an attempt (for example inside
   * `environmentValidateConfig`) leaves the listener armed, so its next
   * respawn retries. A `ready` that arrives during an attempt queues one more
   * attempt. The subscription survives a restart that replaces the worker
   * handle (see `subscribeWorkerReady`).
   */
  const schedulePluginRecovery = (spec: PluginSpec, pluginId: string, workerAccess: PluginWorkerAccess): void => {
    const logBase = { name: spec.name, pluginKey: spec.pluginKey, driverKey: spec.driverKey };
    let settled = false;
    let inFlight = false;
    let queued = false;
    let unsubscribe: (() => void) | null = null;
    const settle = (): void => {
      settled = true;
      unsubscribe?.();
    };
    const attempt = (): void => {
      if (settled) return;
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      recovery.run(async () => {
        try {
          const result = await ensurePluginEntry(spec, workerAccess);
          settle();
          logger.info(
            { ...logBase, environmentId: result.environment.id, action: result.action },
            "managed plugin environment reactivated after plugin worker recovery",
          );
        } catch (err) {
          if (isPermanentConfigRejection(err)) {
            settle();
            logger.error(
              { err, ...logBase },
              "the plugin rejected the managed plugin environment's config; not retrying (degraded: environment unavailable until the config changes)",
            );
          } else {
            logger.warn(
              { err, ...logBase },
              "failed to reactivate managed plugin environment; retrying when the plugin worker is ready again",
            );
          }
        } finally {
          inFlight = false;
          if (queued && !settled) {
            queued = false;
            attempt();
          }
        }
      });
    };
    unsubscribe = subscribeWorkerReady(pluginId, attempt);
    if (!unsubscribe) return;
    recovery.onStop(unsubscribe);
    if (opts.workerManager?.isRunning(pluginId)) attempt();
  };

  for (const spec of pluginSpecs) {
    const logBase = { name: spec.name, pluginKey: spec.pluginKey, driverKey: spec.driverKey };
    let recoverable: { pluginId: string; workerAccess: PluginWorkerAccess } | null = null;
    try {
      const resolved = await resolvePlugin({ db, pluginKey: spec.pluginKey, driverKey: spec.driverKey });
      const manager = opts.workerManager;
      const call = manager?.call;
      // Only a `ready` record that declares the driver can recover without
      // another boot: the worker manager restarts crashed workers, but nothing
      // (re)installs a missing or non-ready plugin at runtime.
      if (resolved && resolved.plugin.status === "ready" && resolved.declaresDriver && manager && call) {
        recoverable = {
          pluginId: resolved.plugin.id,
          workerAccess: { isRunning: manager.isRunning.bind(manager), call: call.bind(manager) },
        };
      }
      const workerRunning = resolved != null && (manager?.isRunning(resolved.plugin.id) ?? false);
      if (!recoverable || !workerRunning) {
        failed += 1;
        const archived = await archivePluginEntry(spec);
        logger.error(
          {
            ...logBase,
            pluginStatus: resolved?.plugin.status ?? null,
            declaresDriver: resolved?.declaresDriver ?? null,
            workerRunning,
            archivedEnvironmentId: archived?.id ?? null,
          },
          "managed plugin environment's plugin is not installed, ready, declaring its driver, and running; skipping ensure and archiving any previously provisioned row (degraded: environment unavailable)",
        );
        if (recoverable) schedulePluginRecovery(spec, recoverable.pluginId, recoverable.workerAccess);
        continue;
      }
      const result = await ensurePluginEntry(spec, recoverable.workerAccess);
      ensured += 1;
      if (result.action === "added") added += 1;
      else if (result.action === "unchanged") unchanged += 1;
      else updated += 1;
      pluginOutcomes.push({
        environmentId: result.environment.id,
        name: result.environment.name,
        pluginKey: spec.pluginKey,
        driverKey: spec.driverKey,
        action: result.action,
      });
      logger.info(
        { ...logBase, environmentId: result.environment.id, action: result.action },
        "managed plugin environment reconciled",
      );
    } catch (err) {
      failed += 1;
      if (recoverable && !isPermanentConfigRejection(err)) {
        if (!recoverable.workerAccess.isRunning(recoverable.pluginId)) {
          // The worker died after the readiness check (for example inside
          // `environmentValidateConfig`): treat it like a plugin that is
          // down, so the row is not left active, and retry on its `ready`.
          const archived = await archivePluginEntry(spec);
          logger.error(
            { err, ...logBase, archivedEnvironmentId: archived?.id ?? null },
            "managed plugin environment's worker stopped during ensure; archived any previously provisioned row and retrying when the plugin worker is ready again (degraded: environment unavailable)",
          );
        } else {
          // The worker is still running (for example the call timed out).
          // Keep any previously provisioned row as it is, so agents keep a
          // working environment; retry once now and on the worker's next
          // `ready`, and otherwise at the next boot.
          logger.error(
            { err, ...logBase },
            "failed to ensure managed plugin environment while its worker is running; keeping any previously provisioned row and retrying (degraded: declaration not applied)",
          );
        }
        schedulePluginRecovery(spec, recoverable.pluginId, recoverable.workerAccess);
      } else {
        logger.error(
          { err, ...logBase },
          "failed to ensure managed plugin environment; continuing boot (degraded: environment unavailable)",
        );
      }
    }
  }

  return {
    ensured,
    failed,
    added,
    updated,
    unchanged,
    skipped,
    removed: 0,
    backedUp: 0,
    outcomes,
    pluginOutcomes,
  };
}

/*
 * One-time `instanceDefault` decision: lifecycle
 *
 * `retryManagedPluginInstanceDefault` is the ONLY caller of
 * `applyManagedPluginInstanceDefault`, and the retry worker below is its only
 * caller. Each attempt enforces:
 *
 * 1. The entry's row can become the default only right after this attempt
 *    ensured the CURRENT declaration (driver config validated by the plugin)
 *    while the plugin passes the boot readiness rule. Otherwise the decision
 *    is recorded with the row as unavailable (`pending`, or `declined` when
 *    the instance already has agents), including before a temporary failure
 *    is rethrown, so the first attempt is always the first evaluation.
 * 2. An admin's explicit default write ends a decision that has not applied
 *    (`cancelPendingManagedEnvironmentDefault`, same transaction as the write).
 * 3. No agent follows the default when it commits (SHARE lock on `agents`).
 *
 * Every non-final state has a way out, and none of them polls:
 *
 * | State                        | Next attempt comes from                    |
 * | ---------------------------- | ------------------------------------------ |
 * | final (applied / declined)   | nothing; attempts exit after one read      |
 * | server just started          | the boot attempt (inline, before `ready`)  |
 * | waiting for the plugin       | a worker `ready` (`onWorkerReady`)         |
 * | config rejected by plugin    | a new boot (the document must change)      |
 * | attempt threw (timeout, db)  | the delivery coordinator's retry (60 s)    |
 */

/** The plugin entry that declares `instanceDefault`, if any (at most one). */
function instanceDefaultSpec(managedConfig: ManagedInstanceConfig | null) {
  return managedConfig?.pluginEnvironments.find((spec) => spec.instanceDefault) ?? null;
}

/**
 * The same readiness rule the boot ensure applies: the plugin is installed and
 * `ready`, declares the entry's environment driver, and has a running worker.
 */
async function isPluginEntryAvailable(
  db: Db,
  spec: ManagedInstanceConfig["pluginEnvironments"][number],
  workerManager: Pick<PluginWorkerManager, "isRunning"> | undefined,
): Promise<boolean> {
  if (!workerManager) return false;
  const resolved = await resolveEnvironmentPluginByKey({ db, pluginKey: spec.pluginKey, driverKey: spec.driverKey });
  return resolved != null
    && resolved.plugin.status === "ready"
    && resolved.declaresDriver
    && workerManager.isRunning(resolved.plugin.id);
}

export type ManagedPluginInstanceDefaultRetryOutcome =
  | "nothing_to_do"
  | "evaluated"
  | "waiting_for_plugin"
  | "config_rejected";

/**
 * Re-run the `instanceDefault` decision for the retry worker. The entry's row
 * counts as active only after a successful ensure of the CURRENT declaration
 * (its driver config validated by the plugin again), never because an older
 * row is still active. Returns without retrying when the decision is final,
 * when the plugin is not available (recorded with the row as unavailable; a
 * worker `ready` asks again), or when the plugin rejects the declared config
 * (recorded the same way; nothing changes until the document does). Throws on
 * any other failure, so the caller retries.
 */
export async function retryManagedPluginInstanceDefault(
  db: Db,
  managedConfig: ManagedInstanceConfig | null,
  workerManager?: Pick<PluginWorkerManager, "isRunning" | "call">,
): Promise<ManagedPluginInstanceDefaultRetryOutcome> {
  const spec = instanceDefaultSpec(managedConfig);
  if (!spec) return "nothing_to_do";
  const decision = await readManagedEnvironmentDefaultDecision(db);
  if (decision && decision.status !== "pending") return "nothing_to_do";
  const marker = managedPluginEnvironmentMarker(spec);
  const environmentsSvc = environmentService(db);
  const recordUnavailable = async () => {
    const existing = await environmentsSvc.findManagedPluginEnvironment({ pluginKey: spec.pluginKey, driverKey: spec.driverKey });
    const outcome = await applyManagedPluginInstanceDefault(db, {
      environment: existing ? { id: existing.id, status: "unavailable" } : null,
      marker,
    });
    if (outcome.status !== "already_decided") {
      logger.warn(
        { name: spec.name, marker, decision: outcome.status, reason: outcome.reason },
        "managed plugin environment is not available; its instanceDefault waits until it is",
      );
    }
  };
  const call = workerManager?.call;
  if (!workerManager || !call || !(await isPluginEntryAvailable(db, spec, workerManager))) {
    await recordUnavailable();
    return "waiting_for_plugin";
  }
  let ensured: Awaited<ReturnType<typeof environmentsSvc.ensureManagedPluginEnvironment>>;
  try {
    ensured = await environmentsSvc.ensureManagedPluginEnvironment({
      name: spec.name,
      description: spec.description,
      pluginKey: spec.pluginKey,
      driverKey: spec.driverKey,
      driverConfig: { ...spec.driverConfig },
      workerManager: { isRunning: workerManager.isRunning.bind(workerManager), call: call.bind(workerManager) },
    });
  } catch (err) {
    if (isPermanentConfigRejection(err)) {
      await recordUnavailable();
      return "config_rejected";
    }
    if (!(await isPluginEntryAvailable(db, spec, workerManager))) {
      await recordUnavailable();
      return "waiting_for_plugin";
    }
    // A temporary failure (for example a timeout with the worker running)
    // still records the first evaluation now, with the row as unavailable, so
    // the retry below continues a `pending` decision ("no agent follows the
    // default by then") instead of re-reading "no agents yet" later.
    await recordUnavailable().catch((recordErr: unknown) => {
      logger.error({ err: recordErr, name: spec.name, marker }, "failed to record the managed plugin environment's pending instance default");
    });
    throw err;
  }
  const outcome = await applyManagedPluginInstanceDefault(db, { environment: ensured.environment, marker });
  const context = {
    environmentId: ensured.environment.id,
    name: spec.name,
    marker,
    decision: outcome.status,
    reason: outcome.reason,
    previousDefaultEnvironmentId: outcome.previousDefaultEnvironmentId,
  };
  if (outcome.status === "applied") {
    logger.info(context, "instance default environment set to the managed plugin environment");
  } else if (outcome.status === "declined") {
    logger.warn(context, "kept the existing instance default environment; the managed plugin environment's instanceDefault will not apply on this instance");
  }
  return "evaluated";
}

/**
 * Register the retry worker for the one-time `instanceDefault` decision, once
 * `applyManagedEnvironments` has finished (returns null when the document
 * declares no `instanceDefault` entry).
 *
 * The worker starts with one requested attempt, which rebuilds the obligation
 * from saved state: it reads the decision row once and stops if the decision
 * is final, and otherwise retries a decision that boot left `pending` (for
 * example after the boot ensure timed out while the worker kept running).
 * After that the obligation is in memory: `requestRetry()` (a failed inline
 * decision) and every worker `ready` ask for one more attempt, and the
 * queue's `hasPending` answers from that request alone, without SQL, so a
 * paused or idle queue never queries. An attempt that throws keeps the
 * request, so the coordinator retries it. `recovery.stop()` removes the
 * `ready` subscription on shutdown.
 */
export function registerManagedPluginInstanceDefaultRetry(input: {
  db: Db;
  managedConfig: ManagedInstanceConfig | null;
  deliveryWork: {
    register(
      queue: typeof DELIVERY_QUEUES.managedEnvironmentDefault,
      task: { retryMs: number; run: () => Promise<unknown>; hasPending: () => Promise<boolean> },
    ): { wake(): void };
  };
  workerManager?: Pick<PluginWorkerManager, "isRunning" | "call" | "onWorkerReady">;
  recovery: ManagedEnvironmentRecovery;
  /**
   * Start with one requested attempt (default). `startManagedPluginInstanceDefault`
   * passes false after its inline boot attempt succeeded.
   */
  requested?: boolean;
  retryMs?: number;
}): { requestRetry(): void } | null {
  if (!instanceDefaultSpec(input.managedConfig)) return null;
  // One attempt from saved state at startup (see above), unless boot made it.
  let requestedGeneration = input.requested === false ? 0 : 1;
  let handledGeneration = 0;
  const worker = input.deliveryWork.register(DELIVERY_QUEUES.managedEnvironmentDefault, {
    retryMs: input.retryMs ?? 60_000,
    run: async () => {
      const target = requestedGeneration;
      if (target === handledGeneration) return;
      await retryManagedPluginInstanceDefault(input.db, input.managedConfig, input.workerManager);
      handledGeneration = target;
    },
    hasPending: async () => requestedGeneration !== handledGeneration,
  });
  const requestRetry = (): void => {
    requestedGeneration += 1;
    worker.wake();
  };
  const unsubscribe = input.workerManager?.onWorkerReady?.(() => requestRetry());
  if (unsubscribe) input.recovery.onStop(unsubscribe);
  return { requestRetry };
}

/**
 * Boot entry point for the one-time `instanceDefault` decision, awaited in
 * `index.ts` right after `applyManagedEnvironments` and before the server
 * reports ready. The first attempt runs inline, through the same
 * `retryManagedPluginInstanceDefault`, so it completes before any request is
 * admitted, including a warm-standby claim and the agent creation that
 * follows it, and whether the delivery coordinator is running does not
 * matter. Then the retry worker is registered for later attempts; it starts
 * with a pending request only when the boot attempt threw.
 */
export async function startManagedPluginInstanceDefault(
  input: Omit<Parameters<typeof registerManagedPluginInstanceDefaultRetry>[0], "requested">,
): Promise<{ requestRetry(): void } | null> {
  if (!instanceDefaultSpec(input.managedConfig)) return null;
  let bootAttemptFailed = false;
  try {
    await retryManagedPluginInstanceDefault(input.db, input.managedConfig, input.workerManager);
  } catch (err) {
    bootAttemptFailed = true;
    logger.error({ err }, "managed plugin environment instance default failed at boot; retrying in the background");
  }
  return registerManagedPluginInstanceDefaultRetry({ ...input, requested: bootAttemptFailed });
}
