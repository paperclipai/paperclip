import type { QueryClient } from "@tanstack/react-query";
import { useQueries } from "@tanstack/react-query";
import { useMemo, useRef, useSyncExternalStore } from "react";
import type { Issue } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "./queryKeys";

export type IssueEntityMap = Record<string, Issue>;

// Per-company entity maps and a single snapshot ref for change detection.
const entityStoreByCompany = new Map<string, IssueEntityMap>();
let snapshotVersion = 0;
const listeners = new Set<() => void>();

function notify() {
  snapshotVersion++;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getVersion() {
  return snapshotVersion;
}

function getOrCreate(companyId: string): IssueEntityMap {
  let map = entityStoreByCompany.get(companyId);
  if (!map) {
    map = {};
    entityStoreByCompany.set(companyId, map);
  }
  return map;
}

function mergeIssue(store: IssueEntityMap, incoming: Issue): boolean {
  const existing = store[incoming.id];
  if (existing && existing.updatedAt >= incoming.updatedAt) return false;
  store[incoming.id] = incoming;
  return true;
}

/**
 * Merges a batch of issues into the normalized entity store.
 * Call directly when you have issues in hand (e.g. optimistic updates).
 */
export function seedIssueEntityStore(
  _queryClient: QueryClient,
  companyId: string,
  issues: readonly Issue[],
): void {
  if (issues.length === 0) return;
  const store = getOrCreate(companyId);
  let changed = false;
  for (const issue of issues) {
    if (issue?.id) changed = mergeIssue(store, issue) || changed;
  }
  if (changed) notify();
}

/**
 * Return the raw entity map for a company. Useful for non-hook contexts such
 * as the live-updates handler.
 */
export function getIssueEntityMap(
  _queryClient: QueryClient,
  companyId: string,
): IssueEntityMap | undefined {
  return entityStoreByCompany.get(companyId);
}

/** Synchronous single-issue read from the entity store. */
export function getIssueFromEntityStore(
  _queryClient: QueryClient,
  companyId: string,
  issueId: string,
): Issue | undefined {
  return entityStoreByCompany.get(companyId)?.[issueId];
}

/**
 * Call once at app boot to wire up automatic entity-store population whenever
 * a list or detail query succeeds in the React Query cache.
 * Returns an unsubscribe function.
 */
export function installIssueEntityStoreSubscriber(queryClient: QueryClient): () => void {
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated") return;
    if (event.query.state.status !== "success") return;
    const raw = event.query.state.data;
    if (!raw) return;

    const key = event.query.queryKey as unknown[];
    if (key[0] !== "issues") return;

    const second = key[1];
    // Skip entity-map-keyed and per-issue-resource keys
    if (second === "detail" || second === "entity-map") return;

    // Derive companyId from list query key shape: ["issues", companyId, ...]
    const companyId = typeof second === "string" ? second : null;

    // Handle InfiniteData<Issue[]>
    if (
      typeof raw === "object" &&
      "pages" in (raw as object) &&
      Array.isArray((raw as { pages: unknown }).pages)
    ) {
      if (!companyId) return;
      const store = getOrCreate(companyId);
      let changed = false;
      for (const page of (raw as { pages: unknown[] }).pages) {
        if (Array.isArray(page)) {
          for (const item of page as Issue[]) {
            if (item?.id) changed = mergeIssue(store, item) || changed;
          }
        }
      }
      if (changed) notify();
      return;
    }

    if (Array.isArray(raw)) {
      // List response: items may be full Issue or IssueSummary.
      if (!companyId) return;
      const store = getOrCreate(companyId);
      let changed = false;
      for (const item of raw as Issue[]) {
        if (item?.id) changed = mergeIssue(store, item) || changed;
      }
      if (changed) notify();
      return;
    }

    // Single-item response: must have id + companyId.
    const item = raw as Issue;
    if (item?.id && item?.companyId) {
      const store = getOrCreate(item.companyId);
      if (mergeIssue(store, item)) notify();
    }
  });
}

const MAX_INDIVIDUAL_FETCH_IDS = 50;

/**
 * Resolves a list of issue IDs to full Issue objects.
 *
 * Issues already known in the entity store are returned immediately.
 * Up to MAX_INDIVIDUAL_FETCH_IDS missing IDs are fetched concurrently via
 * GET /issues/:id (React Query deduplicates across components).
 */
export function useIssuesByIds(
  companyId: string | null | undefined,
  ids: string[] | undefined,
): Issue[] {
  // Re-render whenever the entity store changes.
  const version = useSyncExternalStore(subscribe, getVersion);
  const versionRef = useRef(version);
  versionRef.current = version;

  const store = companyId ? (entityStoreByCompany.get(companyId) ?? {}) : {};

  const missingIds = useMemo(
    () =>
      (ids ?? [])
        .filter((id) => !store[id])
        .slice(0, MAX_INDIVIDUAL_FETCH_IDS),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ids, version],
  );

  // Fetch individually for IDs not yet in entity store.
  useQueries({
    queries: missingIds.map((id) => ({
      queryKey: queryKeys.issues.detail(id),
      queryFn: () => issuesApi.get(id),
      enabled: !!companyId,
      staleTime: 30_000,
    })),
  });

  return useMemo(
    () => (ids ?? []).map((id) => store[id]).filter((i): i is Issue => !!i),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ids, version],
  );
}
