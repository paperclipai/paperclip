import type { AgentProvider } from "./agent-provider.types.js";

export interface OrganizationAgentConfig {
  dualMode: boolean;
  primaryAgent: AgentProvider;
  secondaryAgent: AgentProvider;
}

export interface OrganizationConfig {
  agents?: OrganizationAgentConfig | null;
  customProcess?: {
    enabled?: boolean;
    label?: string;
    instructions?: string;
    triggers?: Array<{
      event: string;
      enabled?: boolean;
      label?: string;
    }>;
  };
}
