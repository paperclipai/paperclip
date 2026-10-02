export const QUALIFIED_ACPX_VERSION = "0.13.1" as const;
export const ACPX_DRIVER_KIND = "acpx_runtime" as const;
export const ACPX_DRIVER_PROTOCOL_VERSION = 1 as const;

import type { NativeAcpxAgent, NativeAcpxProfileSnapshot } from "../../contracts/native-execution.js";

export type QualifiedAcpxAgent = NativeAcpxAgent;

export interface QualifiedAcpxProfile {
  readonly driverKind: typeof ACPX_DRIVER_KIND;
  readonly protocolVersion: typeof ACPX_DRIVER_PROTOCOL_VERSION;
  readonly acpxVersion: typeof QUALIFIED_ACPX_VERSION;
  readonly agent: QualifiedAcpxAgent;
  readonly agentProfileVersion: NativeAcpxProfileSnapshot["agentProfileVersion"];
  readonly qualificationStatus?: "pending";
  readonly modelPolicy?: "explicit-provider-verified";
  /** Wire identity: an npm package name or a runner-owned builtin: identifier. */
  readonly agentServerPackage: string;
  readonly agentServerVersion: string;
  readonly agentRuntimePackage: string | null;
  readonly agentRuntimeVersion: string | null;
  readonly commandDigest: string;
  readonly qualificationModel: string;
  /** Exact model ID sent to ACP; catalogs are suggestions, not an allowlist. */
  readonly reportedModelId: string;
  readonly permissionPolicy: "interactive";
}

/**
 * Digests bind the closed profile declaration (package, version, runtime and
 * executable), not a caller-controlled executable. The environment probe separately
 * verifies the resolved package files before a billable prompt is admitted.
 */
export const QUALIFIED_ACPX_PROFILES: Readonly<
  Record<QualifiedAcpxAgent, QualifiedAcpxProfile>
> = deepFreeze({
  grok: {
    driverKind: ACPX_DRIVER_KIND, protocolVersion: ACPX_DRIVER_PROTOCOL_VERSION,
    acpxVersion: QUALIFIED_ACPX_VERSION, agent: "grok", agentProfileVersion: 1,
    agentServerPackage: "builtin:grok-acp", agentServerVersion: "1",
    agentRuntimePackage: "native:grok", agentRuntimeVersion: "1.0.13",
    commandDigest: "sha256:f0b698395a3704ed2ffaf84ea19bdb20c36c8a0a70b7c629c7b6ffe144e59e55",
    qualificationModel: "grok-4.7", reportedModelId: "grok-4.7", permissionPolicy: "interactive",
  },
  pi: {
    driverKind: ACPX_DRIVER_KIND,
    protocolVersion: ACPX_DRIVER_PROTOCOL_VERSION,
    acpxVersion: QUALIFIED_ACPX_VERSION,
    agent: "pi",
    agentProfileVersion: 13,
    agentServerPackage: "pi-acp",
    agentServerVersion: "0.0.33",
    agentRuntimePackage: "@earendil-works/pi-coding-agent",
    agentRuntimeVersion: "1.0.0",
    commandDigest:
      "sha256:fe1e6da01b2a9e4c691ca27cf689d2d6de846a93be6b23fc1e103c9addd7b177",
    qualificationModel: "openrouter/deepseek/deepseek-v4-flash-0731",
    reportedModelId: "openrouter/deepseek/deepseek-v4-flash-0731",
    permissionPolicy: "interactive",
  },
  cursor: {
    driverKind: ACPX_DRIVER_KIND, protocolVersion: ACPX_DRIVER_PROTOCOL_VERSION,
    acpxVersion: QUALIFIED_ACPX_VERSION, agent: "cursor", agentProfileVersion: 10,
    agentServerPackage: "cursor-agent", agentServerVersion: "2026.09.26-dd393fe",
    agentRuntimePackage: null, agentRuntimeVersion: null,
    commandDigest: "sha256:1df2a15b93bc3a14fa47fa3315344ba023fe2412048047cdc6f32096a6336564",
    // Authenticated discovery has not established a qualification model. Never
    // turn this empty declaration into a default; callers must select an ID.
    qualificationModel: "", reportedModelId: "", permissionPolicy: "interactive",
    modelPolicy: "explicit-provider-verified", qualificationStatus: "pending",
  },
  copilot: {
    driverKind: ACPX_DRIVER_KIND, protocolVersion: ACPX_DRIVER_PROTOCOL_VERSION,
    acpxVersion: QUALIFIED_ACPX_VERSION, agent: "copilot", agentProfileVersion: 13,
    agentServerPackage: "@github/copilot", agentServerVersion: "1.0.88",
    agentRuntimePackage: null, agentRuntimeVersion: null,
    commandDigest: "sha256:3ff08fbe76fe4549c9eb01e8794428d8909c65c151d775220f2ec111d9e6f7c1",
    // Authenticated discovery has not established a qualification model. Never
    // turn this empty declaration into a default; callers must select an ID.
    qualificationModel: "", reportedModelId: "", permissionPolicy: "interactive",
    modelPolicy: "explicit-provider-verified", qualificationStatus: "pending",
  },
  claude: {
    driverKind: ACPX_DRIVER_KIND,
    protocolVersion: ACPX_DRIVER_PROTOCOL_VERSION,
    acpxVersion: QUALIFIED_ACPX_VERSION,
    agent: "claude",
    agentProfileVersion: 1,
    agentServerPackage: "@agentclientprotocol/claude-agent-acp",
    agentServerVersion: "0.73.0",
    agentRuntimePackage: "@anthropic-ai/claude-agent-sdk",
    agentRuntimeVersion: "0.3.280",
    commandDigest:
      "sha256:9d73d1f0f121fb96cc8badb28c22d5bff02d8582eb2e40360a81c189e1b9422a",
    qualificationModel: "claude-sonnet-5",
    reportedModelId: "claude-sonnet-5",
    permissionPolicy: "interactive",
  },
  codex: {
    driverKind: ACPX_DRIVER_KIND,
    protocolVersion: ACPX_DRIVER_PROTOCOL_VERSION,
    acpxVersion: QUALIFIED_ACPX_VERSION,
    agent: "codex",
    agentProfileVersion: 1,
    agentServerPackage: "@agentclientprotocol/codex-acp",
    agentServerVersion: "1.6.2",
    agentRuntimePackage: "@openai/codex",
    agentRuntimeVersion: "0.156.0",
    commandDigest:
      "sha256:c4538599d1ab767db5dff50934f13bb5ba313a59d9c4a83e993fac4617ea63d3",
    qualificationModel: "gpt-5.6-sol",
    reportedModelId: "gpt-5.6-sol",
    permissionPolicy: "interactive",
  },
});

export function resolveQualifiedAcpxProfile(
  agent: QualifiedAcpxAgent,
  requestedModel: string,
): QualifiedAcpxProfile {
  const profile = QUALIFIED_ACPX_PROFILES[agent];
  if (!requestedModel.trim()) throw new Error("ACPX model must not be empty");
  if (agent !== "claude" && agent !== "grok" && profile.modelPolicy !== "explicit-provider-verified" && requestedModel !== profile.qualificationModel) {
    throw new Error(
      `ACPX ${agent} profile requires exact model ${profile.qualificationModel}; received ${requestedModel}`,
    );
  }
  return { ...structuredClone(profile), qualificationModel: requestedModel, reportedModelId: requestedModel };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
