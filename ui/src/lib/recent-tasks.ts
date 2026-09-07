import type { Issue, IssueStatus } from "@paperclipai/shared";

export const RECENT_TASKS_LIMIT = 5;
export const RECENT_TASKS_UPDATED_EVENT = "paperclip:recent-tasks-updated";

export interface RecentTaskEntry {
  id: string;
  companyId: string;
  title: string;
  identifier: string | null;
  status: IssueStatus;
  recordedAt: number;
}

interface RecentTasksUpdatedDetail {
  storageKey: string;
  entries: RecentTaskEntry[];
}

export function getRecentTasksStorageKey(companyId: string, userId: string | null | undefined) {
  return `paperclip.recentTasks:${companyId}:${userId ?? "__local_board__"}`;
}

function isRecentTaskEntry(value: unknown, companyId: string): value is RecentTaskEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<RecentTaskEntry>;
  return entry.companyId === companyId
    && typeof entry.id === "string"
    && entry.id.length > 0
    && typeof entry.title === "string"
    && (entry.identifier === null || typeof entry.identifier === "string")
    && typeof entry.status === "string"
    && typeof entry.recordedAt === "number"
    && Number.isFinite(entry.recordedAt);
}

export function readRecentTasks(storageKey: string, companyId: string): RecentTaskEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return normalizeRecentTasks(
      parsed.filter((entry): entry is RecentTaskEntry => isRecentTaskEntry(entry, companyId)),
    );
  } catch {
    return [];
  }
}

function normalizeRecentTasks(entries: RecentTaskEntry[]) {
  const seen = new Set<string>();
  return [...entries]
    .sort((left, right) => right.recordedAt - left.recordedAt)
    .filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    })
    .slice(0, RECENT_TASKS_LIMIT);
}

function publishRecentTasks(storageKey: string, entries: RecentTaskEntry[]) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<RecentTasksUpdatedDetail>(RECENT_TASKS_UPDATED_EVENT, {
    detail: { storageKey, entries },
  }));
}

export function writeRecentTasks(storageKey: string, entries: RecentTaskEntry[]) {
  if (typeof window === "undefined") return;
  const bounded = normalizeRecentTasks(entries);
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(bounded));
  } catch {
    // The in-tab event still keeps mounted navigation current for this session.
  }
  publishRecentTasks(storageKey, bounded);
}

export function recordRecentTask(
  issue: Pick<Issue, "id" | "companyId" | "title" | "identifier" | "status" | "updatedAt">,
  userId: string | null | undefined,
  recordedAt = new Date(issue.updatedAt).getTime(),
) {
  const storageKey = getRecentTasksStorageKey(issue.companyId, userId);
  const current = readRecentTasks(storageKey, issue.companyId);
  const existing = current.find((candidate) => candidate.id === issue.id);
  const activityAt = Number.isFinite(recordedAt)
    ? recordedAt
    : existing?.recordedAt ?? Date.now();
  const entry: RecentTaskEntry = {
    id: issue.id,
    companyId: issue.companyId,
    title: issue.title,
    identifier: issue.identifier,
    status: issue.status,
    recordedAt: activityAt,
  };
  if (
    existing
    && existing.title === entry.title
    && existing.identifier === entry.identifier
    && existing.status === entry.status
    && existing.recordedAt === entry.recordedAt
  ) return;

  writeRecentTasks(
    storageKey,
    existing
      ? current.map((candidate) => candidate.id === issue.id ? entry : candidate)
      : [entry, ...current],
  );
}

export function pruneRecentTasks(
  storageKey: string,
  companyId: string,
  removeIds: ReadonlySet<string>,
) {
  if (removeIds.size === 0) return;
  const current = readRecentTasks(storageKey, companyId);
  const next = current.filter((entry) => !removeIds.has(entry.id));
  if (next.length !== current.length) writeRecentTasks(storageKey, next);
}

export function updateRecentTaskSnapshots(
  storageKey: string,
  companyId: string,
  issues: ReadonlyArray<Pick<Issue, "id" | "companyId" | "title" | "identifier" | "status" | "updatedAt">>,
) {
  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  const current = readRecentTasks(storageKey, companyId);
  let changed = false;
  const next = current.map((entry) => {
    const issue = issueById.get(entry.id);
    if (!issue || issue.companyId !== companyId) return entry;
    const activityAt = new Date(issue.updatedAt).getTime();
    const nextRecordedAt = Number.isFinite(activityAt) ? activityAt : entry.recordedAt;
    if (
      issue.title === entry.title
      && issue.identifier === entry.identifier
      && issue.status === entry.status
      && nextRecordedAt === entry.recordedAt
    ) return entry;
    changed = true;
    return {
      ...entry,
      title: issue.title,
      identifier: issue.identifier,
      status: issue.status,
      recordedAt: nextRecordedAt,
    };
  });
  if (changed) writeRecentTasks(storageKey, next);
}
