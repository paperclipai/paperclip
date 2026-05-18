/**
 * Phase 4A-S4 (LET-391): bridge from the persisted billing-cap state
 * (`sandbox_billing_cap_state`, owned by the LET-367 cap monitor) into the
 * live E2BSandboxProvider's `resolveBillingCapLayers` callback (added in the
 * same task).
 *
 * Responsibility split:
 *   - LET-367 (B2) writes `providerEnableLayerEnabled` / `operatorToggleEnabled`
 *     to `sandbox_billing_cap_state` on hard-cap breach and operator action.
 *   - LET-366 (B1) implements the live E2BSandboxProvider with a three-gate
 *     acquireLease (env / Layer-1 config / resolved secret).
 *   - LET-391 (this file) reads B2's persisted state and reports it as a
 *     fail-closed layer that runs BEFORE B1's secret resolution, so a flipped
 *     kill-switch blocks the next lease before any HTTP egress.
 *
 * The resolver is intentionally stateless and side-effect-free except for the
 * single `store.load(...)` call. Errors propagate; the provider treats a
 * thrown resolver as a fail-closed signal (see `evaluateBillingCapLayerGate`
 * in `managed-provider-spikes.ts`).
 */

import type {
  E2BBillingCapLayerProbeInput,
  E2BBillingCapLayerSnapshot,
} from "../managed-provider-spikes.js";
import { E2B_PROVIDER_KEY } from "./monitor.js";
import type { BillingCapStateRow, BillingCapStore } from "./store.js";

export interface CreateE2BBillingCapLayerResolverInput {
  store: BillingCapStore;
  /**
   * Resolves the company-id scope for a given lease acquisition. Returning
   * `null` causes the resolver to return `null` (i.e. "no row, allow"),
   * matching the cap monitor's behaviour when no spend has been polled yet
   * for the company × provider key. The bootstrap wires this to a
   * heartbeat-run → issue → company chain (or, in single-tenant pilot mode,
   * to the configured pilot company id).
   */
  resolveCompanyId: (input: E2BBillingCapLayerProbeInput) => Promise<string | null>;
  /** Override the provider key written by the cap monitor (default `"e2b"`). */
  provider?: string;
}

export type E2BBillingCapLayerResolver = (
  input: E2BBillingCapLayerProbeInput,
) => Promise<E2BBillingCapLayerSnapshot | null>;

/**
 * Build a `resolveBillingCapLayers` callback suitable for
 * `E2BSandboxProvider`. The returned function is the single integration point
 * the live provider calls on every `acquireLease`.
 */
export function createE2BBillingCapLayerResolver(
  input: CreateE2BBillingCapLayerResolverInput,
): E2BBillingCapLayerResolver {
  const provider = input.provider ?? E2B_PROVIDER_KEY;
  return async (probeInput) => {
    const companyId = await input.resolveCompanyId(probeInput);
    if (!companyId) return null;
    const row = await input.store.load(companyId, provider);
    return billingCapStateRowToLayerSnapshot(row);
  };
}

/**
 * Project a persisted `sandbox_billing_cap_state` row into the snapshot shape
 * the E2B provider's gate reads. Exposed so the bootstrap and the
 * integration test can share the projection rule (a divergence here would
 * silently weaken the kill-switch).
 */
export function billingCapStateRowToLayerSnapshot(
  row: BillingCapStateRow | null,
): E2BBillingCapLayerSnapshot | null {
  if (!row) return null;
  return {
    providerEnableLayerEnabled: row.providerEnableLayerEnabled !== false,
    operatorToggleEnabled: row.operatorToggleEnabled !== false,
    providerEnableReason: row.providerEnableReason,
    operatorToggleReason: row.operatorToggleReason,
  };
}
