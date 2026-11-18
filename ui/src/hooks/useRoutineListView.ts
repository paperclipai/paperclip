import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "@/lib/router";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import { readRoutineView, routineViewStorageKey, writeRoutineViewParams, type RoutineViewState } from "@/lib/routine-list-view";

export function useRoutineListView(companyId: string | null) {
  const { data: session } = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession() });
  const userId = session?.user?.id ?? session?.session?.userId;
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
  const [local, setLocal] = useState<{ key: string | null; value: RoutineViewState } | null>(null);
  const search = params.toString();
  const state = useMemo(() => readRoutineView(new URLSearchParams(search), local?.key === key ? local.value : saved), [search, local, key, saved]);
  function update(patch: Partial<RoutineViewState>) {
    const next = { ...state, ...patch };
    setLocal({ key, value: next });
    if (key) {
      try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Private browsing can disable storage. */ }
    }
    if (Object.keys(patch).some(field => !["columns", "collapsedGroups"].includes(field))) {
      setParams(current => writeRoutineViewParams(current, next), { replace: true });
    }
  }
  return [state, update] as const;
}
