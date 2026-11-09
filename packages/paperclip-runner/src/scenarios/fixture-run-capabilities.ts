import { CAPABILITY_COMMAND_REQUIRED_CLAIMS } from "../mock-core/capability-control-plane-types.js";

const CAPABILITY_FIXTURE_ADAPTER_CLAIMS = Object.freeze(
  [...new Set(Object.values(CAPABILITY_COMMAND_REQUIRED_CLAIMS).flat())].sort(),
);

/**
 * Gives package-owned Capability fixtures the adapter claims needed to exercise
 * the accepted mock control plane. Model-visible semantic grants remain the
 * scenario claims; this union does not widen the tool catalog exposed to the
 * fake agent or Codex.
 */
export function capabilityFixtureRunCapabilities(
  scenarioClaims: readonly string[],
): string[] {
  return [...new Set([...scenarioClaims, ...CAPABILITY_FIXTURE_ADAPTER_CLAIMS])].sort();
}
