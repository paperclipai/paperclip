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
 */

import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { environmentService } from "./environments.js";
import type { ManagedSandboxEnvironmentReconcileAction } from "./environments.js";
import { instanceSettingsService } from "./instance-settings.js";
import type { ManagedInstanceConfig } from "./managed-config.js";
import type { ManagedResourceStockStatus } from "./managed-resource-drift.js";
import { parseExecutionPolicyBootstrapEnv } from "./execution-policy-bootstrap.js";
import { resolvePluginSandboxProviderDriverByKey } from "./plugin-environment-driver.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

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
   */
  workerManager?: Pick<PluginWorkerManager, "isRunning"> & {
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
  >;
  /** Test seam: overrides the instance-settings service built from `db`. */
  instanceSettings?: Pick<ReturnType<typeof instanceSettingsService>, "get" | "update">;
  /** Test seam: overrides the sandbox-provider plugin driver lookup. */
  resolveSandboxProviderDriver?: (input: {
    db: Db;
    driverKey: string;
  }) => Promise<{ plugin: { id: string; pluginKey: string; status: string } } | null>;
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

  if (managedConfig.environments.length === 0) return null;

  // The forced-execution-mode bootstrap (`PAPERCLIP_EXECUTION_MODE=kubernetes`)
  // and this one both own the single Paperclip-managed sandbox row
  // (`environments_managed_sandbox_idx`). Configuring both is contradictory;
  // refuse startup rather than let bootstrap ordering pick a winner.
  const env = opts.env ?? process.env;
  if (parseExecutionPolicyBootstrapEnv(env)) {
    throw new Error(
      `PAPERCLIP_EXECUTION_MODE and the PAPERCLIP_MANAGED_CONFIG "environments" section are mutually exclusive: both manage the single instance sandbox environment`,
    );
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
  // that shape is usually a crash in restart-backoff, and the manager's
  // respawn re-emits `ready` on the same handle. A one-shot listener re-runs
  // the idempotent ensure so the recovered provider becomes selectable again
  // without waiting for the next boot (this pass has already archived the
  // row). The post-subscribe `isRunning` re-check closes the race where the
  // worker recovered between the gate check and the subscription. No handle
  // means no respawn is coming (activation never started a worker), so the
  // degraded-until-next-boot posture stands.
  const scheduleRecoveryReactivation = (
    spec: ManagedInstanceConfig["environments"][number],
    pluginId: string,
  ): void => {
    const manager = opts.workerManager;
    const handle = manager?.getWorker(pluginId);
    if (!handle) return;
    let reactivated = false;
    const reactivate = (): void => {
      if (reactivated) return;
      reactivated = true;
      handle.off("ready", reactivate);
      void environments
        .ensureManagedSandboxEnvironment({
          name: spec.name,
          description: spec.description,
          provider: spec.provider,
          config: { ...spec.config },
          stockVersion: managedConfig.catalogVersion,
        })
        .then((result) => {
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
        })
        .catch((err: unknown) => {
          logger.error(
            { err, name: spec.name, provider: spec.provider },
            "failed to reactivate managed sandbox environment after provider worker recovery (degraded: environment unavailable until next boot)",
          );
        });
    };
    handle.on("ready", reactivate);
    if (manager?.isRunning(pluginId)) reactivate();
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
          scheduleRecoveryReactivation(spec, resolved.plugin.id);
        }
        continue;
      }
      const reconciliation = await environments.ensureManagedSandboxEnvironment({
        name: spec.name,
        description: spec.description,
        provider: spec.provider,
        config: { ...spec.config },
        stockVersion: managedConfig.catalogVersion,
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
  };
}
