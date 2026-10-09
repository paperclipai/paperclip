import type { Issue, IssueStatus } from "@paperclipai/shared";

export const RECENT_TASKS_LIMIT = 5;
export const RECENT_TASKS_UPDATED_EVENT = "paperclip:recent-tasks-updated";
const STORAGE_PREFIX = "paperclip.recentTasks.v2:";
const LEGACY_STORAGE_PREFIX = "paperclip.recentTasks:";

export interface RecentTaskEntry {
  id: string;
  companyId: string;
  title: string;
  identifier: string | null;
  status: IssueStatus;
  externalConversationState?: Issue["externalConversationState"];
  recordedAt: number;
  // Server version of the title/status snapshot, independent of comment activity.
  // Legacy entries have no version until a detail query refreshes them.
  snapshotUpdatedAt?: number;
}

interface RecentTasksUpdatedDetail {
  storageKey: string;
  entries: RecentTaskEntry[];
}

export function getRecentTasksStorageKey(companyId: string, userId: string | null | undefined) {
  // Old tabs can still publish stale snapshots. Keep their writes out of v2.
  return `${STORAGE_PREFIX}${companyId}:${userId ?? "__local_board__"}`;
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
    && Number.isFinite(entry.recordedAt)
    && (entry.snapshotUpdatedAt === undefined || (
      typeof entry.snapshotUpdatedAt === "number" && Number.isFinite(entry.snapshotUpdatedAt)
    ));
}

export function readRecentTasks(storageKey: string, companyId: string): RecentTaskEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const legacyKey = storageKey.startsWith(STORAGE_PREFIX)
      ? LEGACY_STORAGE_PREFIX + storageKey.slice(STORAGE_PREFIX.length)
      : storageKey;
    const raw = window.localStorage.getItem(storageKey) ?? window.localStorage.getItem(legacyKey);
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return normalizeRecentTasks(
      parsed.filter((entry): entry is RecentTaskEntry => isRecentTaskEntry(entry, companyId)),
    );
  } catch {
    return [];
  }
}

export function migrateRecentTasks(storageKey: string, companyId: string) {
  if (typeof window === "undefined") return;
  try {
    if (window.localStorage.getItem(storageKey) !== null) return;
  } catch {
    return;
  }
  // Persist even an empty list so an old tab cannot seed it again later.
  writeRecentTasks(storageKey, readRecentTasks(storageKey, companyId));
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
    const serialized = JSON.stringify(bounded);
    if (window.localStorage.getItem(storageKey) === serialized) return;
    window.localStorage.setItem(storageKey, serialized);
  } catch {
    // The in-tab event still keeps mounted navigation current for this session.
  }
  publishRecentTasks(storageKey, bounded);
}

type TaskSnapshot = Pick<Issue, "id" | "companyId" | "title" | "identifier" | "status" | "externalConversationState" | "updatedAt">;

export function mergeRecentTaskSnapshot(entry: RecentTaskEntry, issue: TaskSnapshot): RecentTaskEntry {
  if (entry.id !== issue.id || entry.companyId !== issue.companyId) return entry;
  const snapshotUpdatedAt = new Date(issue.updatedAt).getTime();
  if (!Number.isFinite(snapshotUpdatedAt)) return entry;
  if (entry.snapshotUpdatedAt !== undefined && snapshotUpdatedAt < entry.snapshotUpdatedAt) return entry;
  // Conversation readiness also depends on deliveries and decisions, which
  // can change without changing the task's title/status version.
  if (snapshotUpdatedAt === entry.snapshotUpdatedAt) {
    return issue.externalConversationState !== undefined
      && issue.externalConversationState !== entry.externalConversationState
      ? { ...entry, status: issue.status, externalConversationState: issue.externalConversationState }
      : entry;
  }
  return {
    ...entry,
    title: issue.title,
    identifier: issue.identifier,
    status: issue.status,
    externalConversationState: issue.externalConversationState,
    snapshotUpdatedAt,
    recordedAt: Math.max(entry.recordedAt, snapshotUpdatedAt),
  };
}

export function recordRecentTask(
  issue: Pick<Issue, "id" | "companyId" | "title" | "identifier" | "status" | "externalConversationState" | "updatedAt" | "conversationAgentId">,
  userId: string | null | undefined,
  recordedAt = new Date(issue.updatedAt).getTime(),
) {
  if (issue.conversationAgentId) return;
  const storageKey = getRecentTasksStorageKey(issue.companyId, userId);
  const current = readRecentTasks(storageKey, issue.companyId);
  const existing = current.find((candidate) => candidate.id === issue.id);
  const activityAt = Number.isFinite(recordedAt)
    ? recordedAt
    : existing?.recordedAt ?? Date.now();
  const snapshotUpdatedAt = new Date(issue.updatedAt).getTime();
  const snapshot: RecentTaskEntry = existing ? mergeRecentTaskSnapshot(existing, issue) : {
    id: issue.id,
    companyId: issue.companyId,
    title: issue.title,
    identifier: issue.identifier,
    status: issue.status,
    externalConversationState: issue.externalConversationState,
    recordedAt: activityAt,
    ...(Number.isFinite(snapshotUpdatedAt) ? { snapshotUpdatedAt } : {}),
  };
  const entry: RecentTaskEntry = {
    ...snapshot,
    // A comment can promote activity even when its task details are stale.
    recordedAt: Math.max(activityAt, snapshot.recordedAt),
  };
  if (
    existing
    && existing.title === entry.title
    && existing.identifier === entry.identifier
    && existing.status === entry.status
    && existing.externalConversationState === entry.externalConversationState
    && existing.recordedAt === entry.recordedAt
    && existing.snapshotUpdatedAt === entry.snapshotUpdatedAt
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
  issues: ReadonlyArray<TaskSnapshot>,
) {
  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  const current = readRecentTasks(storageKey, companyId);
  let changed = false;
  const next = current.map((entry) => {
    const issue = issueById.get(entry.id);
    if (!issue || issue.companyId !== companyId) return entry;
    const nextEntry = mergeRecentTaskSnapshot(entry, issue);
    if (nextEntry !== entry) changed = true;
    return nextEntry;
  });
  if (changed) writeRecentTasks(storageKey, next);
}
