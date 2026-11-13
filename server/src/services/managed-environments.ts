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
 * `managed-plugin-environments.ts`).
 *
 * Instance default: boot fills an unset, local or deleted default once, under
 * a lock (`fillUnsetInstanceDefault`), and never changes a set one. A plugin
 * entry with `instanceDefault` fills first, right after its ensure; the
 * managed sandbox (under `enableManagedSandboxOnly`) fills after all plugin
 * entries. So a new instance gets the plugin environment, and an existing
 * instance, whose default is already set, keeps its default.
 */

import type { Db } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { environmentService } from "./environments.js";
import type { ManagedSandboxEnvironmentReconcileAction } from "./environments.js";
import { fillUnsetInstanceDefault, type FillInstanceDefaultResult } from "./managed-instance-default.js";
import type { ManagedInstanceConfig } from "./managed-config.js";
import type { ManagedResourceStockStatus } from "./managed-resource-drift.js";
import { parseExecutionPolicyBootstrapEnv } from "./execution-policy-bootstrap.js";
import { resolvePluginSandboxProviderDriverByKey } from "./plugin-environment-driver.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { trackIdleWork } from "./task-admission.js";
import { resolveBundledCatalogRoot, resolveBundledPluginInstalls } from "./bundled-plugins.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import type { ManagedPluginEnvironmentReconcileAction } from "./managed-plugin-environments.js";

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
    | "ensureManagedPluginEnvironment"
    | "archiveManagedPluginEnvironment"
  >;
  /** Test seam: overrides the locked fill of an unset instance default (`fillUnsetInstanceDefault`). */
  fillInstanceDefault?: (environmentId: string) => Promise<FillInstanceDefaultResult>;
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

  const fillInstanceDefault = opts.fillInstanceDefault
    ?? ((environmentId: string) => fillUnsetInstanceDefault(db, environmentId));
  const environments = opts.environments ?? environmentService(db);
  const managedSandboxOnlyDeclared = managedConfig.features.enableManagedSandboxOnly === true;

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
   * Under `enableManagedSandboxOnly`, point the instance default at the
   * managed sandbox row when nothing deliberate is set: an unset default, the
   * (hidden-under-this-mode) local row, or a dangling reference. A set default
   * (any other environment, whoever chose it) is never changed, and nothing
   * reverts the filled default later: it is an ordinary set value from then
   * on. The write is one locked transaction (`fillUnsetInstanceDefault`), so
   * overlapping boots and admin writes cannot overwrite each other.
   *
   * Runs once, after the plugin entries: a plugin entry with
   * `instanceDefault` fills an unset default first (see
   * `fillPluginInstanceDefault`), so on a new instance it wins, and on an
   * existing one (whose default is already set) neither fill changes it.
   *
   * Best-effort: a failure degrades to the run-time policy, which refuses
   * local under managed-sandbox-only regardless.
   */
  const ensureManagedInstanceDefault = async (managedEnvironment: { id: string }): Promise<void> => {
    if (!managedSandboxOnlyDeclared) return;
    try {
      const { filled, previousDefaultEnvironmentId } = await fillInstanceDefault(managedEnvironment.id);
      if (!filled) return;
      logger.info(
        { environmentId: managedEnvironment.id, previousDefaultEnvironmentId },
        "instance default environment set to the managed sandbox environment",
      );
    } catch (err) {
      logger.error(
        { err, environmentId: managedEnvironment.id },
        "failed to reconcile the instance default environment with the managed sandbox environment",
      );
    }
  };

  /**
   * A plugin entry with `instanceDefault` fills the instance default with its
   * row right after a successful boot ensure, through the same locked fill:
   * only an unset, local or deleted default is replaced, and a set default
   * (an existing instance's managed sandbox, an admin's choice) never is.
   * Like an admin's write, the fill declines while active agents following
   * the default lack the plugin's setup; the sandbox fill then runs as usual.
   * Recovery after boot never fills. Best-effort, like the sandbox fill.
   */
  const fillPluginInstanceDefault = async (
    spec: ManagedInstanceConfig["pluginEnvironments"][number],
    environmentId: string,
  ): Promise<void> => {
    if (!spec.instanceDefault) return;
    try {
      const { filled, previousDefaultEnvironmentId, declined } = await fillInstanceDefault(environmentId);
      if (declined) {
        logger.warn(
          { environmentId, name: spec.name, previousDefaultEnvironmentId, declined },
          "kept the instance default: agents that follow it need setup for the managed plugin environment first",
        );
      }
      if (!filled) return;
      logger.info(
        { environmentId, name: spec.name, previousDefaultEnvironmentId },
        "instance default environment set to the managed plugin environment",
      );
    } catch (err) {
      logger.error(
        { err, environmentId, name: spec.name },
        "failed to fill the instance default with the managed plugin environment",
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
  let sandboxDefaultCandidate: string | null = null;
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
      // Filled after the plugin entries (see `ensureManagedInstanceDefault`).
      sandboxDefaultCandidate = reconciliation.environment.id;
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
      ...(spec.runnerLifecycleMode ? { runnerLifecycleMode: spec.runnerLifecycleMode } : {}),
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
      await fillPluginInstanceDefault(spec, result.environment.id);
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


  if (sandboxDefaultCandidate) await ensureManagedInstanceDefault({ id: sandboxDefaultCandidate });

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
