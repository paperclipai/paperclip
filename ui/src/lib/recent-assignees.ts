const STORAGE_KEY = "paperclip:recent-assignees";
const MAX_RECENT = 10;

export function getRecentAssigneeIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function trackRecentAssignee(agentId: string): void {
  if (!agentId) return;
  const recent = getRecentAssigneeIds().filter((id) => id !== agentId);
  recent.unshift(agentId);
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(recent));
}

export function sortAgentsByRecency<T extends { id: string; name: string }>(
  agents: T[],
  recentIds: string[],
): T[] {
  const recentIndex = new Map(recentIds.map((id, i) => [id, i]));
  return [...agents].sort((a, b) => {
    const aRecent = recentIndex.get(a.id);
    const bRecent = recentIndex.get(b.id);
    if (aRecent !== undefined && bRecent !== undefined) return aRecent - bRecent;
    if (aRecent !== undefined) return -1;
    if (bRecent !== undefined) return 1;
    return a.name.localeCompare(b.name);
  });
}
