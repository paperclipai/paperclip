import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type QueryClient, type QueryKey, useQueryClient } from "@tanstack/react-query";
import {
  SharedPollingCoordinator,
  type SharedMessage,
  type SharedPollingSnapshot,
} from "../lib/cross-tab-poll";
import { filterLocalInboxArchivedQueryData } from "../lib/inboxArchiveCache";

type RefetchInterval = number | false;

export interface SharedPollingQueryOptions {
  companyId: string | null | undefined;
  resourceKey: string;
  queryKey: QueryKey;
  enabled?: boolean;
  refetchInterval?: RefetchInterval;
  /**
   * When true, non-leader tabs disable their active polling/query fetch for this
   * resource and render from broadcast/cache data. Use for interval-polled hot
   * endpoints. Leave false for one-shot reads where blank first paint is worse
   * than a duplicated initial fetch.
   */
  leaderOnly?: boolean;
}

export interface SharedPollingQueryState<TData> {
  isLeader: boolean;
  enabled: boolean;
  refetchInterval: RefetchInterval;
  publish: (data: TData | undefined, dataUpdatedAt: number) => void;
}

type RegistryEntry = {
  coordinator: SharedPollingCoordinator;
  refs: number;
};

const coordinators = new Map<string, RegistryEntry>();

function acquireCoordinator(companyId: string): SharedPollingCoordinator {
  const existing = coordinators.get(companyId);
  if (existing) {
    existing.refs += 1;
    return existing.coordinator;
  }
  const coordinator = new SharedPollingCoordinator(companyId);
  coordinator.start();
  coordinators.set(companyId, { coordinator, refs: 1 });
  return coordinator;
}

function releaseCoordinator(companyId: string): void {
  const existing = coordinators.get(companyId);
  if (!existing) return;
  existing.refs -= 1;
  if (existing.refs > 0) return;
  existing.coordinator.stop();
  coordinators.delete(companyId);
}

function resourceKey(companyId: string, key: string, queryKeyHash: string): string {
  return `${companyId}:${key}:${queryKeyHash}`;
}

export function applySharedPollingResult<TData>(
  queryClient: Pick<QueryClient, "getQueryState" | "setQueryData">,
  queryKey: QueryKey,
  message: SharedMessage,
): boolean {
  if (message.type !== "result") return false;
  const incomingUpdatedAt = message.dataUpdatedAt ?? message.at;
  if (incomingUpdatedAt <= 0) return false;
  const localUpdatedAt = queryClient.getQueryState(queryKey)?.dataUpdatedAt ?? 0;
  if (localUpdatedAt >= incomingUpdatedAt) return false;
  const data = filterLocalInboxArchivedQueryData(queryKey, message.data as TData);
  queryClient.setQueryData(queryKey, data, { updatedAt: incomingUpdatedAt });
  return true;
}

export function useSharedPollingQuery<TData>({
  companyId,
  resourceKey: rawResourceKey,
  queryKey,
  enabled = true,
  refetchInterval = false,
  leaderOnly = false,
}: SharedPollingQueryOptions): SharedPollingQueryState<TData> {
  const queryClient = useQueryClient();
  const activeCompanyId = enabled && companyId ? companyId : null;
  const queryKeyHash = useMemo(() => JSON.stringify(queryKey), [queryKey]);
  const fullResourceKey = activeCompanyId ? resourceKey(activeCompanyId, rawResourceKey, queryKeyHash) : null;
  const queryKeyRef = useRef(queryKey);
  const [snapshot, setSnapshot] = useState<SharedPollingSnapshot>({ isLeader: true });

  useEffect(() => {
    queryKeyRef.current = queryKey;
  }, [queryKey, queryKeyHash]);

  useEffect(() => {
    if (!activeCompanyId || !fullResourceKey) {
      setSnapshot({ isLeader: true });
      return;
    }

    const coordinator = acquireCoordinator(activeCompanyId);
    const unsubscribeState = coordinator.subscribe(setSnapshot);
    const unsubscribeResource = coordinator.subscribeResource(fullResourceKey, (message) => {
      applySharedPollingResult(queryClient, queryKeyRef.current, message);
    });
    coordinator.request(fullResourceKey);

    return () => {
      unsubscribeResource();
      unsubscribeState();
      releaseCoordinator(activeCompanyId);
    };
  }, [activeCompanyId, fullResourceKey, leaderOnly, queryClient, queryKeyHash]);

  const isLeader = !leaderOnly || snapshot.isLeader;
  const queryEnabled = enabled && (!leaderOnly || snapshot.isLeader);
  const coordinatedInterval = leaderOnly && !snapshot.isLeader ? false : refetchInterval;

  const publish = useCallback((data: TData | undefined, dataUpdatedAt: number) => {
    if (!activeCompanyId || !fullResourceKey || data === undefined) return;
    const entry = coordinators.get(activeCompanyId);
    entry?.coordinator.publish(fullResourceKey, data, dataUpdatedAt);
  }, [activeCompanyId, fullResourceKey]);

  return useMemo(
    () => ({
      isLeader,
      enabled: queryEnabled,
      refetchInterval: coordinatedInterval,
      publish,
    }),
    [coordinatedInterval, isLeader, publish, queryEnabled],
  );
}

export function usePublishSharedQueryData<TData>(
  shared: Pick<SharedPollingQueryState<TData>, "publish" | "isLeader">,
  data: TData | undefined,
  dataUpdatedAt: number,
): void {
  useEffect(() => {
    if (!shared.isLeader || dataUpdatedAt <= 0) return;
    shared.publish(data, dataUpdatedAt);
  }, [data, dataUpdatedAt, shared]);
}
