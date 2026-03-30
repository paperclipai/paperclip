import type { Agent } from "@paperclipai/shared";

function hasCrewAiHint(value: string | null | undefined): boolean {
  if (!value) return false;
  return value.toLowerCase().includes("crewai");
}

function hasLangGraphHint(value: string | null | undefined): boolean {
  if (!value) return false;
  return value.toLowerCase().includes("langgraph");
}

export function isCrewAiAgent(agent: Pick<Agent, "adapterType" | "adapterConfig" | "capabilities">): boolean {
  if (agent.adapterType !== "http") return false;

  if (hasCrewAiHint(agent.capabilities)) return true;

  const config = (agent.adapterConfig ?? {}) as Record<string, unknown>;
  const runtimeProfile = typeof config.runtimeProfile === "string" ? config.runtimeProfile : "";
  if (runtimeProfile === "http+crewai") return true;
  const url = typeof config.url === "string" ? config.url : "";
  if (hasCrewAiHint(url)) return true;

  const headers = typeof config.headers === "object" && config.headers !== null
    ? (config.headers as Record<string, unknown>)
    : {};

  for (const [key, value] of Object.entries(headers)) {
    if (!hasCrewAiHint(String(value))) continue;
    const lowerKey = key.toLowerCase();
    if (lowerKey === "x-agent-runtime" || lowerKey === "x-runtime" || lowerKey === "x-orchestrator") {
      return true;
    }
  }

  return false;
}

export function isLangGraphAgent(agent: Pick<Agent, "adapterType" | "adapterConfig" | "capabilities">): boolean {
  if (agent.adapterType !== "http") return false;

  if (hasLangGraphHint(agent.capabilities)) return true;

  const config = (agent.adapterConfig ?? {}) as Record<string, unknown>;
  const runtimeProfile = typeof config.runtimeProfile === "string" ? config.runtimeProfile : "";
  if (runtimeProfile === "http+langgraph") return true;
  const url = typeof config.url === "string" ? config.url : "";
  if (hasLangGraphHint(url)) return true;

  const headers = typeof config.headers === "object" && config.headers !== null
    ? (config.headers as Record<string, unknown>)
    : {};

  for (const [key, value] of Object.entries(headers)) {
    if (!hasLangGraphHint(String(value))) continue;
    const lowerKey = key.toLowerCase();
    if (lowerKey === "x-agent-runtime" || lowerKey === "x-runtime" || lowerKey === "x-orchestrator") {
      return true;
    }
  }

  return false;
}

export function runtimeLabelForAgent(
  agent: Pick<Agent, "adapterType" | "adapterConfig" | "capabilities">,
  fallbackLabel: string,
): string {
  if (isCrewAiAgent(agent)) return "CrewAI (HTTP)";
  if (isLangGraphAgent(agent)) return "LangGraph (HTTP)";
  return fallbackLabel;
}
