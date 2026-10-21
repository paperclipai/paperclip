import { ACPX_DRIVER_KIND, ACPX_DRIVER_PROTOCOL_VERSION, QUALIFIED_ACPX_VERSION, QUALIFIED_ACPX_PROFILE_DATA } from "./generated-profiles.js";
export { ACPX_DRIVER_KIND, ACPX_DRIVER_PROTOCOL_VERSION, QUALIFIED_ACPX_VERSION } from "./generated-profiles.js";

import type { NativeAcpxAgent, NativeAcpxProfileSnapshot } from "../../contracts/native-execution.js";

export type QualifiedAcpxAgent = NativeAcpxAgent;

export interface AcpxReleaseProfile {
  readonly driverKind: typeof ACPX_DRIVER_KIND;
  readonly protocolVersion: typeof ACPX_DRIVER_PROTOCOL_VERSION;
  readonly acpxVersion: typeof QUALIFIED_ACPX_VERSION;
  readonly agent: QualifiedAcpxAgent;
  readonly agentProfileVersion: NativeAcpxProfileSnapshot["agentProfileVersion"];
  readonly qualificationStatus?: "pending";
  /** Wire identity: an npm package name or a runner-owned builtin: identifier. */
  readonly agentServerPackage: string;
  readonly agentServerVersion: string;
  readonly agentRuntimePackage: string | null;
  readonly agentRuntimeVersion: string | null;
  readonly commandDigest: string;
  readonly permissionPolicy: "interactive";
}

export interface QualifiedAcpxProfile extends AcpxReleaseProfile {
  /** Caller-selected model; the legacy serialized name preserves recovery identity. */
  readonly qualificationModel: string;
  /** Exact model ID sent to ACP; catalogs are suggestions, not an allowlist. */
  readonly reportedModelId: string;
}

/**
 * Digests bind the closed profile declaration (package, version, runtime and
 * executable), not a caller-controlled executable. The environment probe separately
 * verifies the resolved package files before a billable prompt is admitted.
 */
export const QUALIFIED_ACPX_PROFILES: Readonly<
  Record<QualifiedAcpxAgent, AcpxReleaseProfile>
> = deepFreeze(QUALIFIED_ACPX_PROFILE_DATA);

export function resolveQualifiedAcpxProfile(
  agent: QualifiedAcpxAgent,
  requestedModel: string,
): QualifiedAcpxProfile {
  const profile = QUALIFIED_ACPX_PROFILES[agent];
  if (!requestedModel.trim()) throw new Error("ACPX model must not be empty");
  if (agent === "copilot" && ["auto", "default"].includes(requestedModel.trim().toLowerCase())) throw new Error("Copilot requires an explicit model ID");
  return { ...structuredClone(profile), qualificationModel: requestedModel, reportedModelId: requestedModel };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
