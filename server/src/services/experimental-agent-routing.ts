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
  primaryModel?: string | null;
  secondaryAgent?: AgentProvider;
  secondaryModel?: string | null;
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
  primaryModel: null,
  secondaryAgent: "codex",
  secondaryModel: null,
} satisfies Required<OrganizationAgentConfig>;

export function adapterTypeForAgentProvider(provider: AgentProvider): "claude_local" | "codex_local" {
  return provider === "claude" ? "claude_local" : "codex_local";
}

export function agentProviderForAdapterType(adapterType: string | null | undefined): AgentProvider | null {
  if (adapterType === "claude_local") return "claude";
  if (adapterType === "codex_local") return "codex";
  return null;
}

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
    primaryModel: typeof input.primaryModel === "string" ? input.primaryModel : null,
    secondaryAgent,
    secondaryModel: typeof input.secondaryModel === "string" ? input.secondaryModel : null,
  };
}

function resolveOrganizationAgentConfig(input: AgentRoutingInput): OrganizationAgentConfig | null | undefined {
  if (input.organizationConfig) return input.organizationConfig;
  if (!input.companyExperimentalFeatures?.agentDualMode) return input.organizationConfig;
  return {
    dualMode: input.companyExperimentalFeatures.enabledFeatures?.agent_dual_mode === true,
    ...input.companyExperimentalFeatures.agentDualMode,
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

function validateAgentRoutingPolicy(input: AgentRoutingInput, config: Required<OrganizationAgentConfig>): boolean {
  if (!isAgentDualModeEnabled(input)) return false;
  if (!config.dualMode) return false;
  return config.primaryAgent !== config.secondaryAgent;
}

export class AgentRoutingService {
  resolve(input: AgentRoutingInput): AgentProvider {
    const config = normalizeOrganizationAgentConfig(resolveOrganizationAgentConfig(input));
    if (!validateAgentRoutingPolicy(input, config)) return config.primaryAgent;
    if (this.isAgentAvailable(config.primaryAgent, input)) return config.primaryAgent;
    if (this.isAgentAvailable(config.secondaryAgent, input)) return config.secondaryAgent;
    return config.primaryAgent;
  }

  resolveExecution(input: AgentRoutingInput & { currentAdapterType: string }): {
    provider: AgentProvider | null;
    adapterType: string;
    model: string | null;
    routed: boolean;
  } {
    const currentProvider = agentProviderForAdapterType(input.currentAdapterType);
    if (!currentProvider) {
      return {
        provider: null,
        adapterType: input.currentAdapterType,
        model: null,
        routed: false,
      };
    }

    const config = normalizeOrganizationAgentConfig(resolveOrganizationAgentConfig(input));
    if (!validateAgentRoutingPolicy(input, config) || currentProvider !== config.primaryAgent) {
      return {
        provider: currentProvider,
        adapterType: input.currentAdapterType,
        model: currentProvider === config.primaryAgent ? config.primaryModel : config.secondaryModel,
        routed: false,
      };
    }

    const provider = this.resolve(input);
    return {
      provider,
      adapterType: adapterTypeForAgentProvider(provider),
      model: provider === config.primaryAgent ? config.primaryModel : config.secondaryModel,
      routed: provider !== currentProvider,
    };
  }

  private isAgentAvailable(agent: AgentProvider, input: AgentRoutingInput): boolean {
    const status = agent === "claude" ? input.claudeStatus : input.codexStatus;
    return status === "available" || status === "tokens_low" || status === "unknown" || status === undefined;
  }
}
