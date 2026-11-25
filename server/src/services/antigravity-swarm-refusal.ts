/**
 * The failure code of a requested /swarm that cannot run (services/antigravity-swarm.ts).
 * Kept in this leaf module so run settlement and recovery can name it without
 * importing the swarm service. A refusal waits for the user: nothing retries
 * it automatically, because every automatic attempt would refuse the same way.
 */
export const ANTIGRAVITY_SWARM_UNAVAILABLE = "antigravity_swarm_unavailable";

/**
 * The provider quota a swarm draws on. Google's Antigravity CLI bills a separate
 * pool from the same account's ordinary route (seen live: the CLI's pool was
 * exhausted while the connection answered), so its limits hold only swarms.
 */
export const ANTIGRAVITY_CLI_QUOTA_SCOPE = "antigravity_cli";

/** The activity a signed-in user's /swarm request records (the request's only proof). */
export const ANTIGRAVITY_SWARM_REQUESTED_ACTION = "issue.antigravity_swarm_requested";

/** A Google Antigravity agent: the only kind of agent that runs a /swarm. */
export function isAntigravityAgent(agent: { adapterType: string; adapterConfig: unknown } | null): boolean {
  const config = agent?.adapterConfig !== null && typeof agent?.adapterConfig === "object" && !Array.isArray(agent.adapterConfig)
    ? agent.adapterConfig as Record<string, unknown> : {};
  return agent?.adapterType === "paperclip_runner" && config.provider === "acpx" && config.acpxAgent === "antigravity";
}
