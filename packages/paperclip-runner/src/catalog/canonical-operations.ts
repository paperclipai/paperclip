/** Stable aggregate API over the per-action definitions in `src/protocol-actions/`. */
import type { CapabilitySideEffectClass, CapabilityToolDisposition, CapabilityOptionalCatalogGroup, CapabilityToolTaskMode, ScenarioChatdempotencyBehavior } from "../tools/capability-semantic-tool-types.js";
import { PAPERCLIP_PROTOCOL_ACTIONS } from "../protocol-actions/index.js";

export type CapabilityCatalogSurface = "scenario" | "live";
export type CapabilityRealBindingStatus = "live_codex" | "scenario_mock" | "test_only";
export interface CapabilityCanonicalOperation {
  readonly operationId: string; readonly surfaces: readonly CapabilityCatalogSurface[];
  readonly placement: CapabilityToolDisposition; readonly optionalGroup: CapabilityOptionalCatalogGroup | null;
  readonly requiredClaims: readonly string[]; readonly taskModes: readonly CapabilityToolTaskMode[];
  readonly allowedRoles?: readonly string[]; readonly sideEffectClass: CapabilitySideEffectClass;
  readonly idempotency: ScenarioChatdempotencyBehavior; readonly disabledByDefault: boolean;
  readonly realBindingStatus: CapabilityRealBindingStatus; readonly realServiceBinding: string;
  readonly prpEvidence: string; readonly prpBindingStatus: "audit_pending" | "bound";
  readonly legacyAliases: readonly string[]; readonly note?: string;
}

export const CAPABILITY_CANONICAL_OPERATIONS: readonly CapabilityCanonicalOperation[] = Object.freeze(
  PAPERCLIP_PROTOCOL_ACTIONS
    .map((action) => action.canonical as unknown as CapabilityCanonicalOperation)
    .sort((left, right) => left.operationId.localeCompare(right.operationId)),
);
const byId = new Map(CAPABILITY_CANONICAL_OPERATIONS.map((operation) => [operation.operationId, operation]));
if (byId.size !== 41) throw new Error(`expected 41 canonical semantic operations, found ${byId.size}`);
export function capabilityCanonicalOperation(operationId: string): CapabilityCanonicalOperation | undefined { return byId.get(operationId); }
export function capabilityCanonicalOperationsForSurface(surface: CapabilityCatalogSurface): readonly CapabilityCanonicalOperation[] { return CAPABILITY_CANONICAL_OPERATIONS.filter((operation) => operation.surfaces.includes(surface)); }
export function capabilityCanonicalOperationIds(): readonly string[] { return CAPABILITY_CANONICAL_OPERATIONS.map((operation) => operation.operationId); }
