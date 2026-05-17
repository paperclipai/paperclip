import type { AgentProvider } from "./agent-provider.types.js";
import type { AgentStatus } from "./agent-status.types.js";
import { DEFAULT_ORGANIZATION_AGENT_CONFIG, normalizeOrganizationAgentConfig } from "./dual-mode.config.js";
import type { OrganizationAgentConfig } from "./organization-agent-config.types.js";
import type { PaperclipTask } from "./paperclip-task.types.js";

export interface AgentRoutingInput {
  task: PaperclipTask;
  organizationConfig?: OrganizationAgentConfig | null;
  primaryStatus?: AgentStatus;
  secondaryStatus?: AgentStatus;
  claudeStatus?: AgentStatus;
  codexStatus?: AgentStatus;
}

const FALLBACK_STATUSES = new Set<AgentStatus>(["tokens_empty", "rate_limited", "unavailable"]);

export class AgentRoutingService {
  resolve(input: AgentRoutingInput): AgentProvider {
    const config = normalizeOrganizationAgentConfig(input.organizationConfig ?? DEFAULT_ORGANIZATION_AGENT_CONFIG);

    if (!config.dualMode) {
      return config.primaryAgent;
    }

    if (this.isAgentAvailable(config.primaryAgent, input)) {
      return config.primaryAgent;
    }

    if (this.isAgentAvailable(config.secondaryAgent, input)) {
      return config.secondaryAgent;
    }

    return config.primaryAgent;
  }

  isFallbackStatus(status: AgentStatus | undefined): boolean {
    return FALLBACK_STATUSES.has(status ?? "unknown");
  }

  private isAgentAvailable(agent: AgentProvider, input: AgentRoutingInput): boolean {
    const status = agent === "claude" ? input.claudeStatus : input.codexStatus;
    return status === "available" || status === "tokens_low" || status === "unknown" || status === undefined;
  }

}

export const agentRoutingService = new AgentRoutingService();
