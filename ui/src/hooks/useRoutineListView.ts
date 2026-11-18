import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "@/lib/router";
import { useResolvedViewerId } from "./useResolvedViewerId";
import { readRoutineView, routineViewStorageKey, writeRoutineViewParams, type RoutineViewState } from "@/lib/routine-list-view";

function changesLinkedView(patch: Partial<RoutineViewState>) {
  return Object.keys(patch).some(field => !["columns", "collapsedGroups"].includes(field));
}

export function useRoutineListView(companyId: string | null) {
  const { userId } = useResolvedViewerId();
  const key = companyId && userId ? routineViewStorageKey(companyId, userId) : null;
  const [params, setParams] = useSearchParams();
  const saved = useMemo(() => {
    try {
      if (!key) return null;
      const current = localStorage.getItem(key);
      if (current) return JSON.parse(current);
      const legacy = JSON.parse(localStorage.getItem(`paperclip:routines-view:${companyId}`) ?? "null");
      return legacy ? { sortField: legacy.sortField, sortDir: legacy.sortDir, groupBy: legacy.groupBy, collapsedGroups: legacy.collapsedGroups } : null;
    }
    catch { return null; }
  }, [key, companyId]);
  const [edits, setEdits] = useState<{ key: string | null; companyId: string | null; patch: Partial<RoutineViewState> }>({ key, companyId, patch: {} });
  let scopedEdits = edits;
  if (edits.key !== key || edits.companyId !== companyId) {
    scopedEdits = { key, companyId, patch: edits.companyId === companyId && edits.key === null ? edits.patch : {} };
    setEdits(scopedEdits);
  }
  const personalView = useMemo(() => readRoutineView(new URLSearchParams(), { ...saved, ...scopedEdits.patch }), [saved, scopedEdits.patch]);
  const search = params.toString();
  const state = useMemo(() => readRoutineView(new URLSearchParams(search), personalView), [search, personalView]);
  useEffect(() => {
    if (!key || !Object.keys(scopedEdits.patch).length) return;
    try { localStorage.setItem(key, JSON.stringify(personalView)); } catch {}
  }, [key, personalView, scopedEdits.patch]);
  function update(patch: Partial<RoutineViewState>) {
    const next = { ...state, ...patch };
    setEdits({ key, companyId, patch: { ...scopedEdits.patch, ...(changesLinkedView(patch) ? next : patch) } });
    if (changesLinkedView(patch)) {
      setParams(current => writeRoutineViewParams(current, next), { replace: true });
    }
  }
  return [state, update] as const;
}
