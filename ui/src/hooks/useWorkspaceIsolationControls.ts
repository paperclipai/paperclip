import { useHiddenSettings } from "./useHiddenSettings";

/** Visibility only: hiding controls must never turn off workspace isolation. */
export function useWorkspaceIsolationControls() {
  const { hidden, loaded } = useHiddenSettings();
  return { visible: loaded && !hidden.has("workspaces.isolation"), loaded };
}
