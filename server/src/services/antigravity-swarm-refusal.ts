/**
 * The failure code of a requested /swarm that cannot run (services/antigravity-swarm.ts).
 * Kept in this leaf module so run settlement and recovery can name it without
 * importing the swarm service. A refusal waits for the user: nothing retries
 * it automatically, because every automatic attempt would refuse the same way.
 */
export const ANTIGRAVITY_SWARM_UNAVAILABLE = "antigravity_swarm_unavailable";
