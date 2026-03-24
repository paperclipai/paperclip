import type { SlackConfig, AgentConfig, ChannelMapping } from "../types.js";

// ---------------------------------------------------------------------------
// Lookup tables built from plugin config at runtime
// ---------------------------------------------------------------------------

export interface AgentMaps {
  /** Slack botUserId → Paperclip agentId */
  botUserIdToAgentId: Record<string, string>;
  /** Paperclip agentId → Slack bot token */
  agentIdToToken: Record<string, string>;
  /** Paperclip agentId → display name */
  agentIdToDisplay: Record<string, string>;
  /** All configured agent entries */
  agents: AgentConfig[];
}

/**
 * Build lookup maps from config once per operation.
 * Cheap — just iterates the agents array.
 */
export function buildAgentMaps(config: SlackConfig): AgentMaps {
  const botUserIdToAgentId: Record<string, string> = {};
  const agentIdToToken: Record<string, string> = {};
  const agentIdToDisplay: Record<string, string> = {};

  for (const agent of config.agents ?? []) {
    if (agent.botUserId) {
      botUserIdToAgentId[agent.botUserId] = agent.agentId;
    }
    agentIdToToken[agent.agentId] = agent.botToken;
    agentIdToDisplay[agent.agentId] = agent.displayName ?? agent.agentId;
  }

  return {
    botUserIdToAgentId,
    agentIdToToken,
    agentIdToDisplay,
    agents: config.agents ?? [],
  };
}

/**
 * Return true if the given Slack user ID belongs to one of our bots.
 * Used for echo prevention.
 */
export function isOurBot(userId: string, maps: AgentMaps): boolean {
  return userId in maps.botUserIdToAgentId;
}

/**
 * Find the bot token for an agent, with fallback to defaultAgent.
 */
export function resolveToken(
  config: SlackConfig,
  maps: AgentMaps,
  agentId: string | null | undefined,
): string | null {
  if (agentId && maps.agentIdToToken[agentId]) {
    return maps.agentIdToToken[agentId] ?? null;
  }
  if (config.defaultAgentId && maps.agentIdToToken[config.defaultAgentId]) {
    return maps.agentIdToToken[config.defaultAgentId] ?? null;
  }
  // last resort: first configured agent
  const first = config.agents?.[0];
  return first?.botToken ?? null;
}

/**
 * Find the channel mapping for a Slack channel ID.
 */
export function findChannelMapping(
  config: SlackConfig,
  slackChannelId: string,
): ChannelMapping | null {
  return config.channelMappings?.find((m) => m.slackChannelId === slackChannelId) ?? null;
}
