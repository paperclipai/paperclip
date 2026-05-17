import {
  isExperimentalFeatureEnabled,
  isPaperclipExperimentalModeEnabled,
  type CompanyExperimentalFeaturesConfig,
} from "@paperclipai/shared";
import { isDevelopmentEnvironment } from "../development-environment.js";

export type AgentProvider = "claude" | "codex";
export type AgentStatus = "available" | "tokens_low" | "tokens_empty" | "rate_limited" | "unavailable" | "unknown";

export interface OrganizationAgentConfig {
  dualMode?: boolean;
  primaryAgent?: AgentProvider;
  secondaryAgent?: AgentProvider;
}

export interface AgentRoutingInput {
  organizationConfig?: OrganizationAgentConfig | null;
  claudeStatus?: AgentStatus;
  codexStatus?: AgentStatus;
  companyExperimentalFeatures?: CompanyExperimentalFeaturesConfig | null;
  environmentExperimentalModeEnabled?: boolean;
  isDevelopmentEnvironment?: boolean;
}

export const DEFAULT_ORGANIZATION_AGENT_CONFIG = {
  dualMode: false,
  primaryAgent: "claude",
  secondaryAgent: "codex",
} satisfies Required<OrganizationAgentConfig>;

function isAgentProvider(value: unknown): value is AgentProvider {
  return value === "claude" || value === "codex";
}

function normalizeOrganizationAgentConfig(input?: OrganizationAgentConfig | null) {
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

function isAgentDualModeEnabled(input: AgentRoutingInput): boolean {
  return isExperimentalFeatureEnabled({
    feature: "agent_dual_mode",
    environmentExperimentalModeEnabled:
      input.environmentExperimentalModeEnabled ?? isPaperclipExperimentalModeEnabled(process.env),
    isDevelopmentEnvironment: input.isDevelopmentEnvironment ?? isDevelopmentEnvironment(),
    companyEnabledFeatures: input.companyExperimentalFeatures?.enabledFeatures,
  });
}

export class AgentRoutingService {
  resolve(input: AgentRoutingInput): AgentProvider {
    const config = normalizeOrganizationAgentConfig(input.organizationConfig);
    if (!isAgentDualModeEnabled(input) || !config.dualMode) return config.primaryAgent;
    if (this.isAgentAvailable(config.primaryAgent, input)) return config.primaryAgent;
    if (this.isAgentAvailable(config.secondaryAgent, input)) return config.secondaryAgent;
    return config.primaryAgent;
  }

  private isAgentAvailable(agent: AgentProvider, input: AgentRoutingInput): boolean {
    const status = agent === "claude" ? input.claudeStatus : input.codexStatus;
    return status === "available" || status === "tokens_low" || status === "unknown" || status === undefined;
  }
}
