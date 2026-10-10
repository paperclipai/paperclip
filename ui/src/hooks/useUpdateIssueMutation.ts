import { useCallback, useMemo, useRef } from "react";
import {
  useMutation,
  useQueryClient,
  type MutateOptions,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { describeError, isTransientError } from "@/api/errors";
import { issuesApi, type IssueUpdateResponse } from "@/api/issues";
import { useToastActions } from "@/context/ToastContext";
import { useConnectivityStore } from "@/lib/connectivity";
import { applyOptimisticIssueFieldUpdate, matchesIssueRef } from "@/lib/optimistic-issue-comments";
import { queryKeys } from "@/lib/queryKeys";

export interface UpdateIssueVariables {
  /** Issue id or identifier. */
  id: string;
  data: Record<string, unknown>;
}

type QuerySnapshot = Array<[QueryKey, unknown]>;

export interface UpdateIssueContext {
  snapshot: QuerySnapshot;
}

/**
 * Fields that carry more than an absolute value: replaying them could post a
 * second comment or interrupt twice. Updates with any of these never resend
 * on their own.
 */
const NON_REPLAYABLE_FIELDS = ["comment", "interrupt", "attachmentIds", "reopen"] as const;

/** True when sending this update twice has the same effect as once. */
export function isReplayableIssueUpdate(data: Record<string, unknown>): boolean {
  return NON_REPLAYABLE_FIELDS.every((field) => !Object.prototype.hasOwnProperty.call(data, field));
}

function isIssueLike(value: unknown): value is Issue {
  return !!value && typeof value === "object" && typeof (value as Issue).id === "string";
}

/**
 * Apply `update` to every issue inside cached query data of the shapes the
 * app uses: one issue, an issue list, and infinite pages of lists.
 */
export function mapIssuesInQueryData(data: unknown, refs: ReadonlySet<string>, update: (issue: Issue) => Issue): unknown {
  if (Array.isArray(data)) {
    let changed = false;
    const next = data.map((item) => {
      if (Array.isArray(item)) {
        const mapped = mapIssuesInQueryData(item, refs, update);
        if (mapped !== item) changed = true;
        return mapped;
      }
      if (!isIssueLike(item) || !matchesIssueRef(item, refs)) return item;
      changed = true;
      return update(item);
    });
    return changed ? next : data;
  }
  if (data && typeof data === "object" && Array.isArray((data as { pages?: unknown }).pages)) {
    const infinite = data as { pages: unknown[] };
    const pages = mapIssuesInQueryData(infinite.pages, refs, update);
    return pages === infinite.pages ? data : { ...infinite, pages };
  }
  if (isIssueLike(data) && matchesIssueRef(data, refs)) return update(data);
  return data;
}

/** Optimistically apply `data` to the issue everywhere it is cached; returns a snapshot for rollback. */
export function applyOptimisticIssueUpdate(
  queryClient: QueryClient,
  companyId: string | null | undefined,
  refs: ReadonlySet<string>,
  data: Record<string, unknown>,
): QuerySnapshot {
  const snapshot: QuerySnapshot = [];
  const filters = [
    { queryKey: ["issues", "detail"] as QueryKey },
    ...(companyId ? [{ queryKey: ["issues", companyId] as QueryKey }] : []),
  ];
  for (const filter of filters) {
    for (const [queryKey, cached] of queryClient.getQueriesData({ queryKey: filter.queryKey })) {
      const next = mapIssuesInQueryData(cached, refs, (issue) => applyOptimisticIssueFieldUpdate(issue, data) ?? issue);
      if (next === cached) continue;
      snapshot.push([queryKey, cached]);
      queryClient.setQueryData(queryKey, next);
    }
  }
  return snapshot;
}

export interface UseUpdateIssueMutationOptions {
  companyId: string | null | undefined;
  /** Query keys this surface lists issues under; refreshed after every update. */
  invalidateKeys?: QueryKey[];
  onSuccess?: (result: IssueUpdateResponse, variables: UpdateIssueVariables) => void;
  onSettled?: () => void;
  /** What the user was doing, for error copy. */
  action?: string;
}

export interface UpdateIssueMutation {
  mutate: (
    variables: UpdateIssueVariables,
    options?: MutateOptions<IssueUpdateResponse, Error, UpdateIssueVariables, UpdateIssueContext>,
  ) => void;
  mutateAsync: (
    variables: UpdateIssueVariables,
    options?: MutateOptions<IssueUpdateResponse, Error, UpdateIssueVariables, UpdateIssueContext>,
  ) => Promise<IssueUpdateResponse>;
  isPending: boolean;
  variables: UpdateIssueVariables | undefined;
}

/**
 * The one issue-update mutation: optimistic update of every cached copy,
 * rollback and readable toast on failure, and `meta.replay = "idempotent"`
 * for absolute-field updates so they pause through an outage and resend on
 * reconnect instead of failing.
 */
export function useUpdateIssueMutation(options: UseUpdateIssueMutationOptions): UpdateIssueMutation {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const connectivity = useConnectivityStore();
  const { companyId, invalidateKeys, onSuccess, onSettled, action = "update the task" } = options;

  const mutationOptions = {
    mutationFn: ({ id, data }: UpdateIssueVariables) => issuesApi.update(id, data),
    onMutate: async ({ id, data }: UpdateIssueVariables): Promise<UpdateIssueContext> => {
      const refs = new Set([id]);
      const cached = queryClient.getQueryData<Issue>(queryKeys.issues.detail(id));
      if (cached?.id) refs.add(cached.id);
      if (cached?.identifier) refs.add(cached.identifier);
      // Stop in-flight reads of this issue and its lists from overwriting the
      // optimistic value; other issues' reads keep going.
      await Promise.all([
        ...[...refs].map((ref) => queryClient.cancelQueries({ queryKey: queryKeys.issues.detail(ref) })),
        ...(companyId ? [queryClient.cancelQueries({ queryKey: queryKeys.issues.list(companyId) })] : []),
      ]);
      return { snapshot: applyOptimisticIssueUpdate(queryClient, companyId, refs, data) };
    },
    onSuccess: (result: IssueUpdateResponse, variables: UpdateIssueVariables) => {
      onSuccess?.(result, variables);
    },
    onError: (error: Error, _variables: UpdateIssueVariables, context: UpdateIssueContext | undefined) => {
      for (const [queryKey, previous] of context?.snapshot ?? []) queryClient.setQueryData(queryKey, previous);
      // While the connection banner is up it already explains an outage.
      if (isTransientError(error) && connectivity.getSnapshot().status !== "online") return;
      const { title, body } = describeError(error, { action });
      pushToast({ title, body, tone: "error" });
    },
    onSettled: (_result: unknown, _error: unknown, variables: UpdateIssueVariables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(variables.id) });
      for (const queryKey of invalidateKeys ?? (companyId ? [queryKeys.issues.list(companyId)] : [])) {
        void queryClient.invalidateQueries({ queryKey });
      }
      onSettled?.();
    },
  };
  // Two observers, because `meta` is fixed per mutation: absolute updates may
  // replay across an outage, anything else fails fast.
  const replayable = useMutation({ ...mutationOptions, meta: { replay: "idempotent" } });
  const direct = useMutation(mutationOptions);

  // Stable callbacks: callers list `mutate` in effect and callback deps.
  const replayableRef = useRef(replayable);
  replayableRef.current = replayable;
  const directRef = useRef(direct);
  directRef.current = direct;
  const pick = (variables: UpdateIssueVariables) =>
    isReplayableIssueUpdate(variables.data) ? replayableRef.current : directRef.current;
  const mutate = useCallback<UpdateIssueMutation["mutate"]>(
    (variables, mutateOptions) => pick(variables).mutate(variables, mutateOptions),
    [],
  );
  const mutateAsync = useCallback<UpdateIssueMutation["mutateAsync"]>(
    (variables, mutateOptions) => pick(variables).mutateAsync(variables, mutateOptions),
    [],
  );
  const latest = (replayable.submittedAt ?? 0) >= (direct.submittedAt ?? 0) ? replayable : direct;

  return useMemo(
    () => ({
      mutate,
      mutateAsync,
      isPending: replayable.isPending || direct.isPending,
      variables: latest.variables,
    }),
    [direct.isPending, latest.variables, mutate, mutateAsync, replayable.isPending],
  );
}
