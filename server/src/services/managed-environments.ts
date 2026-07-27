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
 * (`archiveManagedSandboxEnvironment`) for the same reason; the next healthy
 * boot's ensure re-activates it.
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
import type { ManagedInstanceConfig } from "./managed-config.js";
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
   */
  workerManager?: Pick<PluginWorkerManager, "isRunning">;
  /** Test seam: overrides the environment service built from `db`. */
  environments?: Pick<
    ReturnType<typeof environmentService>,
    "ensureManagedSandboxEnvironment" | "archiveManagedSandboxEnvironment"
  >;
  /** Test seam: overrides the sandbox-provider plugin driver lookup. */
  resolveSandboxProviderDriver?: (input: {
    db: Db;
    driverKey: string;
  }) => Promise<{ plugin: { id: string; pluginKey: string; status: string } } | null>;
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
): Promise<{ ensured: number; failed: number } | null> {
  if (!managedConfig || managedConfig.environments.length === 0) return null;

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
  const environments = opts.environments ?? environmentService(db);
  let ensured = 0;
  let failed = 0;
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
        continue;
      }
      const environment = await environments.ensureManagedSandboxEnvironment({
        name: spec.name,
        description: spec.description,
        provider: spec.provider,
        config: { ...spec.config },
      });
      ensured += 1;
      logger.info(
        { environmentId: environment.id, name: environment.name, provider: spec.provider },
        "managed sandbox environment ensured",
      );
    } catch (err) {
      failed += 1;
      logger.error(
        { err, name: spec.name, provider: spec.provider },
        "failed to ensure managed sandbox environment; continuing boot (degraded: environment unavailable)",
      );
    }
  }
  return { ensured, failed };
}
