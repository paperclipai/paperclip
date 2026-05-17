import type { AgentProvider } from "./agent-provider.types.js";
import type { OrganizationAgentConfig } from "./organization-agent-config.types.js";
import { isDevelopmentEnvironment } from "../development-environment.js";

export const DEFAULT_ORGANIZATION_AGENT_CONFIG: OrganizationAgentConfig = {
  dualMode: false,
  primaryAgent: "claude",
  secondaryAgent: "codex",
};

export function isAgentProvider(value: unknown): value is AgentProvider {
  return value === "claude" || value === "codex";
}

export function normalizeOrganizationAgentConfig(
  input?: Partial<OrganizationAgentConfig> | null,
): OrganizationAgentConfig {
  if (!isDevelopmentEnvironment()) return DEFAULT_ORGANIZATION_AGENT_CONFIG;
  if (!input || typeof input !== "object") return DEFAULT_ORGANIZATION_AGENT_CONFIG;
  const primaryAgent = isAgentProvider(input.primaryAgent)
    ? input.primaryAgent
    : DEFAULT_ORGANIZATION_AGENT_CONFIG.primaryAgent;
  const secondaryAgent = isAgentProvider(input.secondaryAgent)
    ? input.secondaryAgent
    : DEFAULT_ORGANIZATION_AGENT_CONFIG.secondaryAgent;
  if (primaryAgent === secondaryAgent) return DEFAULT_ORGANIZATION_AGENT_CONFIG;
  return {
    dualMode: input.dualMode === true,
    primaryAgent,
    secondaryAgent,
  };
}

export function readOrganizationAgentConfig(input: unknown): OrganizationAgentConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return DEFAULT_ORGANIZATION_AGENT_CONFIG;
  }
  const config = input as { agents?: Partial<OrganizationAgentConfig> | null };
  return normalizeOrganizationAgentConfig(config.agents);
}
