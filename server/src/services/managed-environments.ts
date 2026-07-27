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
 * Removing an entry from the document stops future refreshes but never
 * deletes or archives the row — there is intentionally no unprovision path
 * here, matching `plugins.autoInstall` semantics (leases may still reference
 * the row; withdrawal is an explicit operator action).
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

export interface ApplyManagedEnvironmentsOptions {
  env?: Record<string, string | undefined>;
  /** Test seam: overrides the environment service built from `db`. */
  environments?: Pick<
    ReturnType<typeof environmentService>,
    "ensureManagedSandboxEnvironment"
  >;
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

  const environments = opts.environments ?? environmentService(db);
  let ensured = 0;
  let failed = 0;
  for (const spec of managedConfig.environments) {
    try {
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
