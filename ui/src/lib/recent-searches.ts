const STORAGE_PREFIX = "paperclip:recent-searches:";
const MAX_RECENT_SEARCHES = 5;

function storageKey(companyId: string) {
  return `${STORAGE_PREFIX}${companyId}`;
}

function isStorageAvailable() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function loadRecentSearches(companyId: string): string[] {
  if (!isStorageAvailable() || !companyId) return [];
  try {
    const raw = window.localStorage.getItem(storageKey(companyId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const cleaned: string[] = [];
    for (const value of parsed) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (!trimmed) continue;
      cleaned.push(trimmed);
      if (cleaned.length >= MAX_RECENT_SEARCHES) break;
    }
    return cleaned;
  } catch {
    return [];
  }
}

export function pushRecentSearch(companyId: string, query: string): string[] {
  if (!isStorageAvailable() || !companyId) return [];
  const trimmed = query.trim();
  if (!trimmed) return loadRecentSearches(companyId);
  const existing = loadRecentSearches(companyId);
  const filtered = existing.filter((entry) => entry.toLowerCase() !== trimmed.toLowerCase());
  const next = [trimmed, ...filtered].slice(0, MAX_RECENT_SEARCHES);
  try {
    window.localStorage.setItem(storageKey(companyId), JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}

export function clearRecentSearches(companyId: string): void {
  if (!isStorageAvailable() || !companyId) return;
  try {
    window.localStorage.removeItem(storageKey(companyId));
  } catch {
    // ignore
  }
}

export const RECENT_SEARCHES_LIMIT = MAX_RECENT_SEARCHES;
