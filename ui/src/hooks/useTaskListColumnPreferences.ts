import { useRef, useState } from "react";
import { allTaskListColumns, type TaskListColumnId } from "@/lib/task-list";
import { loadTaskCollectionPreferences, saveTaskCollectionPreferences, type TaskCollectionPreferenceLocation } from "@/lib/task-collection-preferences";

function normalizeColumns(value: unknown, fallback: readonly TaskListColumnId[]): TaskListColumnId[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is TaskListColumnId => allTaskListColumns.includes(id)))] : [...fallback];
}

export function useTaskListColumnPreferences(location: TaskCollectionPreferenceLocation | undefined, initialColumns: readonly TaskListColumnId[]) {
  const key = JSON.stringify(location ?? null);
  const load = () => {
    const fallback = { key, columns: [...initialColumns], order: allTaskListColumns };
    if (!location) return fallback;
    try {
      const saved = loadTaskCollectionPreferences({
        ...location,
        defaultColumns: [...initialColumns],
        defaultViewState: { order: allTaskListColumns },
        normalizeColumns: value => normalizeColumns(value, initialColumns),
        normalizeViewState: value => {
          const order = normalizeColumns((value as { order?: unknown } | null)?.order, allTaskListColumns);
          return { order: [...order, ...allTaskListColumns.filter(id => !order.includes(id))] };
        },
      });
      return { key, columns: saved.columns, order: saved.viewState.order };
    } catch {
      return fallback;
    }
  };
  const [state, setState] = useState(load);
  const current = state.key === key ? state : load();
  const latest = useRef(current);
  latest.current = current;
  const update = (patch: { columns?: readonly TaskListColumnId[]; order?: readonly TaskListColumnId[] }) => {
    const next = { ...latest.current, ...patch, columns: [...(patch.columns ?? latest.current.columns)] };
    latest.current = next;
    setState(next);
    try {
      if (location) saveTaskCollectionPreferences(location, { columns: next.columns, viewState: { order: next.order } });
    } catch {}
  };
  return { columns: current.columns, order: current.order, setColumns: (columns: readonly TaskListColumnId[]) => update({ columns }), setOrder: (order: readonly TaskListColumnId[]) => update({ order }) };
}
