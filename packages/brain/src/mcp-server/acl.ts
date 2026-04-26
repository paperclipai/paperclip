import type { BrainDb } from "../db/client.js";
import { getAclForAgent } from "../db/queries.js";

export interface AgentScope {
  agentId: string;
  allowedFolders: string[];
}

export async function getAgentScope(db: BrainDb, agentId: string): Promise<AgentScope> {
  const allowedFolders = await getAclForAgent(db, agentId);
  return { agentId, allowedFolders };
}

export function isFolderAllowed(scope: AgentScope, folder: string): boolean {
  return scope.allowedFolders.includes(folder);
}

export function isAgentExcludedByFrontmatter(
  agentId: string,
  frontmatter: Record<string, unknown> | null | undefined,
): boolean {
  if (!frontmatter) return false;
  const excl = frontmatter.agent_exclude;
  return Array.isArray(excl) && excl.some((v) => typeof v === "string" && v === agentId);
}
