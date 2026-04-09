import type { AdapterAgent } from "./types.js";

export type AgentExecutionBoundary = "specialist_allowed" | "orchestrator_only";

type ExecutionBoundaryAgentLike = Pick<
  AdapterAgent,
  "name" | "role" | "title" | "capabilities" | "runtimeConfig"
>;

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function parseExecutionBoundary(value: unknown): AgentExecutionBoundary | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "specialist_allowed") return "specialist_allowed";
  if (normalized === "orchestrator_only") return "orchestrator_only";
  return null;
}

export function inferLegacyAgentExecutionBoundary(
  agent: ExecutionBoundaryAgentLike,
): AgentExecutionBoundary {
  const haystack = [
    agent.role ?? "",
    agent.name ?? "",
    agent.title ?? "",
    agent.capabilities ?? "",
  ].join(" ").toLowerCase();

  if (
    haystack.includes("chief operating") ||
    haystack.includes("coo") ||
    haystack.includes("operat") ||
    haystack.includes("orchestrat")
  ) {
    return "orchestrator_only";
  }

  return "specialist_allowed";
}

export function resolveAgentExecutionBoundary(
  agent: ExecutionBoundaryAgentLike,
): AgentExecutionBoundary {
  const runtimeConfig = parseObject(agent.runtimeConfig);
  const explicitBoundary =
    parseExecutionBoundary(runtimeConfig.executionBoundary) ??
    parseExecutionBoundary(runtimeConfig.agentExecutionBoundary);
  if (explicitBoundary) return explicitBoundary;

  if (typeof runtimeConfig.allowSpecialistExecution === "boolean") {
    return runtimeConfig.allowSpecialistExecution ? "specialist_allowed" : "orchestrator_only";
  }

  return inferLegacyAgentExecutionBoundary(agent);
}

export function isOrchestratorOnlyAgent(agent: ExecutionBoundaryAgentLike): boolean {
  return resolveAgentExecutionBoundary(agent) === "orchestrator_only";
}
