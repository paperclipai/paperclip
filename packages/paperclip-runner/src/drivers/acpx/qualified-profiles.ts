import { ACPX_DRIVER_KIND, ACPX_DRIVER_PROTOCOL_VERSION, QUALIFIED_ACPX_VERSION, QUALIFIED_ACPX_PROFILE_DATA } from "./generated-profiles.js";
export { ACPX_DRIVER_KIND, ACPX_DRIVER_PROTOCOL_VERSION, QUALIFIED_ACPX_VERSION } from "./generated-profiles.js";

import type { NativeAcpxAgent, NativeAcpxProfileSnapshot } from "../../contracts/native-execution.js";

export type QualifiedAcpxAgent = NativeAcpxAgent;

export type AcpxCandidateAgent = "pi" | "cursor" | "copilot" | "antigravity" | "dsh";
export type AcpxProviderPolicyAgent = "pi" | "cursor" | "copilot" | "dsh";
export function isAcpxCandidateAgent(agent: string | undefined): agent is AcpxCandidateAgent {
  return agent === "pi" || agent === "cursor" || agent === "copilot" || agent === "antigravity" || agent === "dsh";
}
export function isAcpxProviderPolicyAgent(agent: string | undefined): agent is AcpxProviderPolicyAgent {
  return agent === "pi" || agent === "cursor" || agent === "copilot" || agent === "dsh";
}

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

/** Release admission uses canonical build metadata, never a caller's snapshot. */
export function assertAcpxProfileReleased(agent: QualifiedAcpxAgent): void {
  if (QUALIFIED_ACPX_PROFILES[agent].qualificationStatus === "pending") {
    throw Object.assign(new Error(`ACPX ${agent} qualification is pending; this build cannot launch the provider.`),
      { code: "ACPX_PROFILE_QUALIFICATION_PENDING", retryable: false });
  }
}

export function resolveQualifiedAcpxProfile(
  agent: QualifiedAcpxAgent,
  requestedModel: string,
): QualifiedAcpxProfile {
  const profile = QUALIFIED_ACPX_PROFILES[agent];
  if (!requestedModel.trim()) throw new Error("ACPX model must not be empty");
  if (agent === "copilot" && ["auto", "default"].includes(requestedModel.trim().toLowerCase())) throw new Error("Copilot requires an explicit model ID");
  if (agent === "dsh" && requestedModel !== requestedModel.trim()) throw new Error("DSH model ID must not contain surrounding whitespace");
  const reportedModelId = agent === "dsh"
    ? JSON.stringify(["deepseek-official", requestedModel])
    : requestedModel;
  return { ...structuredClone(profile), qualificationModel: requestedModel, reportedModelId };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
