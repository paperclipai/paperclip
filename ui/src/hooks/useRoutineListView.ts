import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "@/lib/router";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";
import { readRoutineView, routineViewStorageKey, writeRoutineViewParams, type RoutineViewState } from "@/lib/routine-list-view";

function changesLinkedView(patch: Partial<RoutineViewState>) {
  return Object.keys(patch).some(field => !["columns", "collapsedGroups"].includes(field));
}

export function useRoutineListView(companyId: string | null) {
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession() });
  const sessionUserId = session.data?.user?.id ?? session.data?.session?.userId;
  const health = useQuery({ queryKey: queryKeys.health, queryFn: () => healthApi.get(), enabled: session.isSuccess && !sessionUserId });
  const userId = session.isSuccess ? sessionUserId ?? (health.isSuccess && health.data.deploymentMode === "local_trusted" ? "local-board" : null) : null;
  const key = companyId && userId ? routineViewStorageKey(companyId, userId) : null;
  const [params, setParams] = useSearchParams();
  const saved = useMemo(() => {
    try {
      if (!key) return null;
      const current = localStorage.getItem(key);
      if (current) return JSON.parse(current);
      // Earlier releases saved only presentation at company scope.
      const legacy = JSON.parse(localStorage.getItem(`paperclip:routines-view:${companyId}`) ?? "null");
      return legacy ? { sortField: legacy.sortField, sortDir: legacy.sortDir, groupBy: legacy.groupBy, collapsedGroups: legacy.collapsedGroups } : null;
    }
    catch { return null; }
  }, [key, companyId]);
  const [local, setLocal] = useState<{ key: string | null; companyId: string | null; value: RoutineViewState; savedValue: RoutineViewState; patch: Partial<RoutineViewState> } | null>(null);
  const pendingPatch = local?.key === null && local.companyId === companyId ? local.patch : null;
  const search = params.toString();
  const state = useMemo(() => readRoutineView(new URLSearchParams(search),
    local?.key === key && local?.companyId === companyId ? local.value : { ...saved, ...pendingPatch }), [search, local, key, companyId, saved, pendingPatch]);
  useEffect(() => {
    if (!key || !pendingPatch) return;
    // Carry only edits made while this company's initial identity was loading.
    const savedValue = changesLinkedView(pendingPatch) ? state : { ...readRoutineView(new URLSearchParams(), saved), ...pendingPatch };
    setLocal({ key, companyId, value: state, savedValue, patch: pendingPatch });
    try { localStorage.setItem(key, JSON.stringify(savedValue)); } catch { /* Storage is optional. */ }
  }, [key, companyId, pendingPatch, state, saved]);
  function update(patch: Partial<RoutineViewState>) {
    const next = { ...state, ...patch };
    const mergedPatch = { ...pendingPatch, ...patch };
    const personalView = local?.key === key && local.companyId === companyId ? local.savedValue : readRoutineView(new URLSearchParams(), saved);
    const savedValue = changesLinkedView(mergedPatch) ? next : { ...personalView, ...mergedPatch };
    setLocal({ key, companyId, value: next, savedValue, patch: mergedPatch });
    if (key) {
      try { localStorage.setItem(key, JSON.stringify(savedValue)); } catch { /* Private browsing can disable storage. */ }
    }
    if (changesLinkedView(patch)) {
      setParams(current => writeRoutineViewParams(current, next), { replace: true });
    }
  }
  return [state, update] as const;
}
