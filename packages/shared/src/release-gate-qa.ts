import type { AgentStatus } from "./constants.js";

export const QA_RELEASE_DEFAULT_NAME = "QA and Release Engineer";
export const QA_RELEASE_DEFAULT_TITLE = "QA and Release Engineer";

export type ReleaseGateQaResolutionSource =
  | "configured"
  | "configured_unavailable"
  | "canonical"
  | "single_fallback"
  | "none"
  | "ambiguous";

type ReleaseGateQaCandidate = {
  id: string;
  role?: string | null;
  status?: AgentStatus | string | null;
  name?: string | null;
  title?: string | null;
};

function normalizeQaDesignation(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

export function isEligibleQaAgentStatus(status: AgentStatus | string | null | undefined) {
  return status !== "paused" && status !== "terminated" && status !== "pending_approval" && status !== "error";
}

export function isConfigurableReleaseGateQaAgentStatus(status: AgentStatus | string | null | undefined) {
  return status !== "terminated" && status !== "pending_approval" && status !== "error";
}

export function isCanonicalReleaseGateQaAgent(agent: {
  name?: string | null;
  title?: string | null;
}) {
  const designations = new Set([
    normalizeQaDesignation(agent.name),
    normalizeQaDesignation(agent.title),
  ]);
  return designations.has(normalizeQaDesignation(QA_RELEASE_DEFAULT_NAME))
    || designations.has(normalizeQaDesignation(QA_RELEASE_DEFAULT_TITLE));
}

export function resolveReleaseGateQaAgent<T extends ReleaseGateQaCandidate>(
  agents: T[],
  options?: { configuredAgentId?: string | null },
) {
  const eligibleQaAgents = agents.filter((agent) =>
    agent.role === "qa" && isEligibleQaAgentStatus(agent.status));
  const canonicalQaAgents = eligibleQaAgents.filter((agent) => isCanonicalReleaseGateQaAgent(agent));
  const configuredAgentId = options?.configuredAgentId?.trim() || null;
  const configuredQaAgent = configuredAgentId
    ? agents.find((agent) => agent.id === configuredAgentId) ?? null
    : null;

  if (configuredAgentId) {
    if (
      configuredQaAgent
      && configuredQaAgent.role === "qa"
      && isEligibleQaAgentStatus(configuredQaAgent.status)
    ) {
      return {
        eligibleQaAgents,
        canonicalQaAgents,
        configuredQaAgent,
        releaseGateQaAgent: configuredQaAgent,
        resolution: "configured" as const,
      };
    }
  }

  if (canonicalQaAgents.length === 1) {
    return {
      eligibleQaAgents,
      canonicalQaAgents,
      configuredQaAgent,
      releaseGateQaAgent: canonicalQaAgents[0]!,
      resolution: "canonical" as const,
    };
  }

  if (canonicalQaAgents.length > 1) {
    return {
      eligibleQaAgents,
      canonicalQaAgents,
      configuredQaAgent,
      releaseGateQaAgent: null,
      resolution: "ambiguous" as const,
    };
  }

  if (eligibleQaAgents.length === 1) {
    return {
      eligibleQaAgents,
      canonicalQaAgents,
      configuredQaAgent,
      releaseGateQaAgent: eligibleQaAgents[0]!,
      resolution: "single_fallback" as const,
    };
  }

  if (configuredAgentId) {
    return {
      eligibleQaAgents,
      canonicalQaAgents,
      configuredQaAgent,
      releaseGateQaAgent: null,
      resolution: "configured_unavailable" as const,
    };
  }

  return {
    eligibleQaAgents,
    canonicalQaAgents,
    configuredQaAgent,
    releaseGateQaAgent: null,
    resolution: eligibleQaAgents.length === 0 ? "none" as const : "ambiguous" as const,
  };
}
