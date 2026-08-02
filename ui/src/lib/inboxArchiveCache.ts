import { useSyncExternalStore } from "react";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { queryKeys } from "./queryKeys";

export type InboxIssueCacheSnapshot = Array<readonly [QueryKey, Issue[] | undefined]>;

const INBOX_ARCHIVE_CONFIRMATION_GRACE_MS = 5_000;
const INBOX_ARCHIVE_MAX_GUARD_MS = 30_000;
const EMPTY_ARCHIVED_ISSUE_IDS: ReadonlySet<string> = new Set();

type InboxArchiveGuardState = {
  issueIds: ReadonlySet<string>;
  listeners: Set<() => void>;
  confirmationTimers: Map<string, ReturnType<typeof setTimeout>>;
  maximumTimers: Map<string, ReturnType<typeof setTimeout>>;
};

const inboxArchiveGuards = new Map<string, InboxArchiveGuardState>();

function pruneInboxArchiveGuard(companyId: string, state: InboxArchiveGuardState) {
  if (
    state.issueIds.size === 0
    && state.listeners.size === 0
    && state.confirmationTimers.size === 0
    && state.maximumTimers.size === 0
    && inboxArchiveGuards.get(companyId) === state
  ) {
    inboxArchiveGuards.delete(companyId);
  }
}

function getInboxArchiveGuard(companyId: string): InboxArchiveGuardState {
  const existing = inboxArchiveGuards.get(companyId);
  if (existing) return existing;

  const created: InboxArchiveGuardState = {
    issueIds: EMPTY_ARCHIVED_ISSUE_IDS,
    listeners: new Set(),
    confirmationTimers: new Map(),
    maximumTimers: new Map(),
  };
  inboxArchiveGuards.set(companyId, created);
  return created;
}

function publishInboxArchiveGuard(state: InboxArchiveGuardState, issueIds: Set<string>) {
  state.issueIds = issueIds.size > 0 ? issueIds : EMPTY_ARCHIVED_ISSUE_IDS;
  for (const listener of state.listeners) listener();
}

function clearArchiveGuardTimer(
  timers: Map<string, ReturnType<typeof setTimeout>>,
  issueId: string,
) {
  const timer = timers.get(issueId);
  if (timer) clearTimeout(timer);
  timers.delete(issueId);
}

export function beginLocalInboxArchive(companyId: string, issueId: string) {
  const state = getInboxArchiveGuard(companyId);
  clearArchiveGuardTimer(state.confirmationTimers, issueId);
  clearArchiveGuardTimer(state.maximumTimers, issueId);

  const issueIds = new Set(state.issueIds);
  issueIds.add(issueId);
  publishInboxArchiveGuard(state, issueIds);
}

export function boundLocalInboxArchive(companyId: string, issueId: string) {
  const state = inboxArchiveGuards.get(companyId);
  if (!state?.issueIds.has(issueId)) return;

  clearArchiveGuardTimer(state.maximumTimers, issueId);
  state.maximumTimers.set(issueId, setTimeout(() => {
    clearLocalInboxArchive(companyId, issueId);
  }, INBOX_ARCHIVE_MAX_GUARD_MS));
}

export function confirmLocalInboxArchive(companyId: string, issueId: string) {
  const state = inboxArchiveGuards.get(companyId);
  if (!state?.issueIds.has(issueId)) return;

  clearArchiveGuardTimer(state.confirmationTimers, issueId);
  state.confirmationTimers.set(issueId, setTimeout(() => {
    clearLocalInboxArchive(companyId, issueId);
  }, INBOX_ARCHIVE_CONFIRMATION_GRACE_MS));
}

export function clearLocalInboxArchive(companyId: string, issueId: string) {
  const state = inboxArchiveGuards.get(companyId);
  if (!state) return;
  clearArchiveGuardTimer(state.confirmationTimers, issueId);
  clearArchiveGuardTimer(state.maximumTimers, issueId);
  if (!state.issueIds.has(issueId)) {
    pruneInboxArchiveGuard(companyId, state);
    return;
  }

  const issueIds = new Set(state.issueIds);
  issueIds.delete(issueId);
  publishInboxArchiveGuard(state, issueIds);
  pruneInboxArchiveGuard(companyId, state);
}

export function getLocalInboxArchiveIssueIds(companyId: string | null | undefined): ReadonlySet<string> {
  if (!companyId) return EMPTY_ARCHIVED_ISSUE_IDS;
  return inboxArchiveGuards.get(companyId)?.issueIds ?? EMPTY_ARCHIVED_ISSUE_IDS;
}

export function useLocalInboxArchiveIssueIds(companyId: string | null | undefined): ReadonlySet<string> {
  return useSyncExternalStore(
    (listener) => {
      if (!companyId) return () => undefined;
      const state = getInboxArchiveGuard(companyId);
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
        pruneInboxArchiveGuard(companyId, state);
      };
    },
    () => getLocalInboxArchiveIssueIds(companyId),
    () => EMPTY_ARCHIVED_ISSUE_IDS,
  );
}

export function filterLocalInboxArchivedIssues(
  companyId: string | null | undefined,
  issues: Issue[],
): Issue[] {
  const issueIds = getLocalInboxArchiveIssueIds(companyId);
  if (issueIds.size === 0) return issues;
  return issues.filter((issue) => !issueIds.has(issue.id));
}

function inboxIssueCompanyIdFromQueryKey(queryKey: QueryKey): string | null {
  const inboxQueryKind = String(queryKey[2]);
  if (
    queryKey[0] !== "issues"
    || typeof queryKey[1] !== "string"
    || !["compact", "mine-by-me", "touched-by-me", "unread-touched-by-me"].includes(inboxQueryKind)
  ) {
    return null;
  }
  return queryKey[1];
}

export function filterLocalInboxArchivedQueryData<TData>(queryKey: QueryKey, data: TData): TData {
  const companyId = inboxIssueCompanyIdFromQueryKey(queryKey);
  if (!companyId || !Array.isArray(data)) return data;
  return filterLocalInboxArchivedIssues(companyId, data as Issue[]) as TData;
}

function inboxIssueQueryPrefixes(companyId: string) {
  return [
    queryKeys.issues.listMineByMe(companyId),
    queryKeys.issues.listTouchedByMe(companyId),
    queryKeys.issues.listUnreadTouchedByMe(companyId),
  ] as const;
}

function resolveRestoreIndex(currentData: Issue[], previousData: Issue[], previousIndex: number) {
  for (let index = previousIndex - 1; index >= 0; index -= 1) {
    const beforeIndex = currentData.findIndex((issue) => issue.id === previousData[index]?.id);
    if (beforeIndex >= 0) return beforeIndex + 1;
  }

  for (let index = previousIndex + 1; index < previousData.length; index += 1) {
    const afterIndex = currentData.findIndex((issue) => issue.id === previousData[index]?.id);
    if (afterIndex >= 0) return afterIndex;
  }

  return Math.min(previousIndex, currentData.length);
}

export async function cancelInboxIssueQueries(queryClient: QueryClient, companyId: string) {
  await Promise.all(
    inboxIssueQueryPrefixes(companyId).map((queryKey) =>
      queryClient.cancelQueries({ queryKey }),
    ),
  );
}

export function snapshotInboxIssueCaches(
  queryClient: QueryClient,
  companyId: string,
): InboxIssueCacheSnapshot {
  return inboxIssueQueryPrefixes(companyId).flatMap((queryKey) =>
    queryClient.getQueriesData<Issue[]>({ queryKey }),
  );
}

export function removeIssueFromInboxCaches(
  queryClient: QueryClient,
  companyId: string,
  issueId: string,
) {
  for (const queryKey of inboxIssueQueryPrefixes(companyId)) {
    queryClient.setQueriesData<Issue[]>(
      { queryKey },
      (cached) => cached?.filter((issue) => issue.id !== issueId),
    );
  }
}

export function restoreIssueToInboxCaches(
  queryClient: QueryClient,
  snapshot: InboxIssueCacheSnapshot,
  issueId: string,
) {
  for (const [queryKey, previousData] of snapshot) {
    if (!previousData) continue;

    const previousIndex = previousData.findIndex((issue) => issue.id === issueId);
    if (previousIndex < 0) continue;

    const issueToRestore = previousData[previousIndex];
    queryClient.setQueryData<Issue[]>(queryKey, (currentData) => {
      if (currentData?.some((issue) => issue.id === issueId)) return currentData;

      const nextData = [...(currentData ?? [])];
      nextData.splice(resolveRestoreIndex(nextData, previousData, previousIndex), 0, issueToRestore);
      return nextData;
    });
  }
}

export function invalidateInboxIssueQueries(queryClient: QueryClient, companyId: string) {
  return Promise.all([
    ...inboxIssueQueryPrefixes(companyId).map((queryKey) =>
      queryClient.invalidateQueries({ queryKey }),
    ),
    queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) }),
  ]);
}

export function getIssuePresenceInActiveInboxCaches(
  queryClient: QueryClient,
  companyId: string,
  issueId: string,
): "absent" | "present" | "unknown" {
  const activeQueries = inboxIssueQueryPrefixes(companyId).flatMap((queryKey) =>
    queryClient.getQueryCache().findAll({ queryKey })
      .filter((query) => query.getObserversCount() > 0),
  );
  if (activeQueries.length === 0) return "unknown";

  const isPresent = activeQueries.some((query) => {
    const data = query.state.data;
    return Array.isArray(data) && data.some((issue) => (issue as Issue).id === issueId);
  });
  return isPresent ? "present" : "absent";
}
