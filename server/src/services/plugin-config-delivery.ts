/**
 * Plugin config delivery — race-free host→worker `configChanged` sends.
 *
 * Two paths deliver a company's stored config to a running plugin worker:
 *
 *  1. The operator config-save route (`routes/plugins.ts`), right after
 *     persisting the new config.
 *  2. The plugin loader's startup replay (`plugin-loader.ts` step 5b), which
 *     fans out every stored company's config to a freshly-started worker.
 *
 * Delivering a value captured *before* the send creates a lost-update race:
 * an operator save landing between the loader's `listConfigs` snapshot and
 * the replay loop would be delivered first and then overwritten by the stale
 * snapshot row, leaving the worker on old config even though the database
 * holds the new value. The same shape exists between two concurrent saves.
 *
 * `deliverStoredCompanyConfig` closes the race by construction:
 *
 *  - All deliveries for a plugin are serialized through a per-plugin promise
 *    chain, so two sends can never interleave.
 *  - The config row is re-read from the database *inside* the critical
 *    section, immediately before the send.
 *
 * A save always enqueues its delivery after its row is committed, and every
 * delivery reads the latest committed row at execution time — so whichever
 * delivery runs last carries the newest value, regardless of how saves and
 * the startup replay interleave.
 */

import type { ConfigChangedParams } from "@paperclipai/plugin-sdk";

export interface ConfigDeliveryRegistry {
  /** Latest stored config row for a plugin/company pair, or null if none. */
  getConfig(
    pluginId: string,
    companyId: string,
  ): Promise<{ configJson: unknown } | null>;
}

export interface ConfigDeliveryWorkerManager {
  /** Send a configChanged RPC to the plugin's worker (rejects on RPC error/timeout). */
  call(
    pluginId: string,
    method: "configChanged",
    params: ConfigChangedParams,
  ): Promise<unknown>;
}

export interface DeliverStoredConfigResult {
  /** True when a `configChanged` RPC was sent (and acknowledged). */
  delivered: boolean;
  /** Set when delivery was skipped because no config row exists (anymore). */
  reason?: "no-config";
}

// Per-plugin delivery chain. Module-level on purpose: the loader and the
// config-save route are separate modules but must serialize against each
// other, and both run in the one server process that owns the worker.
const deliveryChains = new Map<string, Promise<unknown>>();

/**
 * Deliver the *current* stored config for `(pluginId, companyId)` to the
 * plugin's worker via `configChanged`, serialized per plugin.
 *
 * RPC errors (cross-tenant rejection, method-not-implemented, timeout)
 * propagate to the caller; the delivery chain itself always continues.
 */
export async function deliverStoredCompanyConfig(input: {
  registry: ConfigDeliveryRegistry;
  workerManager: ConfigDeliveryWorkerManager;
  pluginId: string;
  companyId: string;
}): Promise<DeliverStoredConfigResult> {
  const { registry, workerManager, pluginId, companyId } = input;

  const tail = deliveryChains.get(pluginId) ?? Promise.resolve();
  const run = tail.then(async (): Promise<DeliverStoredConfigResult> => {
    // Critical section: read-latest-then-send, with no other delivery for
    // this plugin in flight.
    const row = await registry.getConfig(pluginId, companyId);
    if (!row) return { delivered: false, reason: "no-config" };

    await workerManager.call(pluginId, "configChanged", {
      config: (row.configJson ?? {}) as Record<string, unknown>,
      companyId,
    });
    return { delivered: true };
  });

  // The chain must survive a failed delivery, so park a settled continuation
  // as the new tail and drop it once the chain drains.
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  deliveryChains.set(pluginId, settled);
  void settled.then(() => {
    if (deliveryChains.get(pluginId) === settled) deliveryChains.delete(pluginId);
  });

  return run;
}
