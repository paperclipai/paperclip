export const QUALIFIED_ACPX_VERSION = "0.13.1" as const;
export const ACPX_DRIVER_KIND = "acpx_runtime" as const;
export const ACPX_DRIVER_PROTOCOL_VERSION = 1 as const;

import type { NativeAcpxAgent } from "../../contracts/native-execution.js";

export type QualifiedAcpxAgent = NativeAcpxAgent;

export interface QualifiedAcpxProfile {
  readonly driverKind: typeof ACPX_DRIVER_KIND;
  readonly protocolVersion: typeof ACPX_DRIVER_PROTOCOL_VERSION;
  readonly acpxVersion: typeof QUALIFIED_ACPX_VERSION;
  readonly agent: QualifiedAcpxAgent;
  readonly agentProfileVersion: 1;
  readonly agentServerPackage: string;
  readonly agentServerVersion: string;
  readonly agentRuntimePackage: string | null;
  readonly agentRuntimeVersion: string | null;
  readonly commandDigest: string;
  readonly qualificationModel: string;
  /**
   * Model identifier the pinned ACP server accepts and reports. Profile
   * resolution first binds the caller's exact canonical model request. Most
   * agents use that same identifier at the ACP boundary; Claude exposes its
   * stable SDK selector (`sonnet`) while the SDK resolves it to the canonical
   * wire model (`claude-sonnet-5`). Paperclip selects only this profile-pinned
   * identifier and verifies the provider reports it before publishing the
   * canonical model as the qualified effective model.
   */
  readonly reportedModelId: string;
  readonly permissionPolicy: "interactive";
}

/**
 * Digests bind the closed profile declaration (package, version, runtime and
 * model), not a caller-controlled executable. The environment probe separately
 * verifies the resolved package files before a billable prompt is admitted.
 */
export const QUALIFIED_ACPX_PROFILES: Readonly<
  Record<QualifiedAcpxAgent, QualifiedAcpxProfile>
> = deepFreeze({
  pi: {
    driverKind: ACPX_DRIVER_KIND,
    protocolVersion: ACPX_DRIVER_PROTOCOL_VERSION,
    acpxVersion: QUALIFIED_ACPX_VERSION,
    agent: "pi",
    agentProfileVersion: 1,
    agentServerPackage: "pi-acp",
    agentServerVersion: "0.0.33",
    agentRuntimePackage: "@earendil-works/pi-coding-agent",
    agentRuntimeVersion: "0.84.2",
    commandDigest:
      "sha256:8c696f38296d53d0061fa11534570c5ddd951b63532aed30e0f1fcc676dc169f",
    qualificationModel: "openrouter/deepseek/deepseek-v4-flash-0731",
    reportedModelId: "openrouter/deepseek/deepseek-v4-flash-0731",
    permissionPolicy: "interactive",
  },
  claude: {
    driverKind: ACPX_DRIVER_KIND,
    protocolVersion: ACPX_DRIVER_PROTOCOL_VERSION,
    acpxVersion: QUALIFIED_ACPX_VERSION,
    agent: "claude",
    agentProfileVersion: 1,
    agentServerPackage: "@agentclientprotocol/claude-agent-acp",
    agentServerVersion: "0.70.0",
    agentRuntimePackage: "@anthropic-ai/claude-agent-sdk",
    agentRuntimeVersion: "0.3.232",
    commandDigest:
      "sha256:9d73d1f0f121fb96cc8badb28c22d5bff02d8582eb2e40360a81c189e1b9422a",
    qualificationModel: "claude-sonnet-5",
    reportedModelId: "sonnet",
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
    agentRuntimeVersion: "0.148.0",
    commandDigest:
      "sha256:7a923b3829884d3cabcc9659d22cace3f86813e7bfffc90974b10140a45bc400",
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
  if (requestedModel !== profile.qualificationModel) {
    throw new Error(
      `ACPX ${agent} profile requires exact model ${profile.qualificationModel}; received ${requestedModel}`,
    );
  }
  return structuredClone(profile);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
