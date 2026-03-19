const LEGACY_STORAGE_KEY = "paperclip:recent-assignees";
const STORAGE_KEY_PREFIX = `${LEGACY_STORAGE_KEY}:company`;
const MAX_RECENT = 10;

export function buildRecentAssigneeStorageKey(companyId: string | null | undefined): string {
  return companyId ? `${STORAGE_KEY_PREFIX}:${companyId}` : LEGACY_STORAGE_KEY;
}

function parseStoredRecentIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function getRecentAssigneeIds(companyId?: string | null): string[] {
  const scoped = parseStoredRecentIds(localStorage.getItem(buildRecentAssigneeStorageKey(companyId)));
  if (scoped.length > 0 || !companyId) return scoped;
  return parseStoredRecentIds(localStorage.getItem(LEGACY_STORAGE_KEY));
}

export function trackRecentAssignee(agentId: string, companyId?: string | null): void {
  if (!agentId) return;
  const recent = getRecentAssigneeIds(companyId).filter((id) => id !== agentId);
  recent.unshift(agentId);
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
  localStorage.setItem(buildRecentAssigneeStorageKey(companyId), JSON.stringify(recent));
  if (companyId) {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  }
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
