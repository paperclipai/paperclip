import {
  RECENT_SELECTION_DISPLAY_LIMIT,
  readRecentSelectionIds,
  trackRecentSelectionId,
} from "./recent-selections";

const STORAGE_KEY = "paperclip:recent-assignees";

function agentSelectionId(agentId: string): string {
  return `agent:${agentId}`;
}

function userSelectionId(userId: string): string {
  return `user:${userId}`;
}

function agentIdFromSelectionId(id: string): string | null {
  if (id.startsWith("agent:")) return id.slice("agent:".length);
  if (!id.includes(":")) return id;
  return null;
}

export function getRecentAssigneeIds(): string[] {
  return readRecentSelectionIds(STORAGE_KEY)
    .map(agentIdFromSelectionId)
    .filter((id): id is string => Boolean(id));
}

export function getRecentAssigneeSelectionIds(): string[] {
  return readRecentSelectionIds(STORAGE_KEY).map((id) => {
    if (id.includes(":")) return id;
    return agentSelectionId(id);
  });
}

export function trackRecentAssignee(agentId: string): void {
  trackRecentSelectionId(STORAGE_KEY, agentSelectionId(agentId));
}

export function trackRecentAssigneeUser(userId: string): void {
  trackRecentSelectionId(STORAGE_KEY, userSelectionId(userId));
}

export function sortAgentsByRecency<T extends { id: string; name: string }>(
  agents: T[],
  recentIds: string[],
): T[] {
  const recentIndex = new Map(recentIds.slice(0, RECENT_SELECTION_DISPLAY_LIMIT).map((id, i) => [id, i]));
  return [...agents].sort((a, b) => {
    const aRecent = recentIndex.get(a.id);
    const bRecent = recentIndex.get(b.id);
    if (aRecent !== undefined && bRecent !== undefined) return aRecent - bRecent;
    if (aRecent !== undefined) return -1;
    if (bRecent !== undefined) return 1;
    return a.name.localeCompare(b.name);
  });
}
