import { useCallback, useEffect, useRef, useState } from "react";
import { resolveAgentGraphLayout, type AgentGraphLayout } from "@paperclipai/shared";
import { useUiLayout } from "@/hooks/useUiLayout";
import { defaultAgentGraphLayout } from "./lib/graph-nodes";

export function useAgentGraphDocument(companyId: string) {
  const { stored, isLoaded, save, stage, saveState, saveError, retrySave, loadError, blocked, allowOverwrite, retryLoad, owner } = useUiLayout({
    companyId,
    surface: "agent_graph",
    resolve: resolveAgentGraphLayout,
  });
  const [layout, setLayout] = useState<AgentGraphLayout | null>(null);
  const layoutRef = useRef<AgentGraphLayout | null>(null);
  const hadStoredLayout = useRef(false);
  const [restoreCount, setRestoreCount] = useState(0);

  const wasBlocked = useRef(false);
  const loadedOwner = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded) return;
    const recovered = wasBlocked.current && blocked === null && stored !== null;
    wasBlocked.current = blocked !== null;
    const ownerChanged = loadedOwner.current !== null && loadedOwner.current !== owner;
    loadedOwner.current = owner;
    if (layoutRef.current && !recovered && !ownerChanged) return;
    hadStoredLayout.current = stored !== null;
    const initial = stored ?? defaultAgentGraphLayout();
    layoutRef.current = initial;
    setLayout(initial);
    if (recovered || ownerChanged) setRestoreCount((count) => count + 1);
  }, [isLoaded, stored, blocked, owner]);

  const apply = useCallback(
    (update: (current: AgentGraphLayout) => AgentGraphLayout) => {
      const before = layoutRef.current;
      if (!before) return;
      const after = update(before);
      if (after === before) return;
      layoutRef.current = after;
      setLayout(after);
      save(after);
    },
    [save],
  );

  const setViewport = useCallback(
    (viewport: NonNullable<AgentGraphLayout["viewport"]>) => {
      const current = layoutRef.current;
      if (!current) return;
      const previous = current.viewport;
      if (previous && previous.x === viewport.x && previous.y === viewport.y && previous.zoom === viewport.zoom) return;
      const next = { ...current, viewport };
      layoutRef.current = next;
      setLayout(next);
      stage(next);
    },
    [stage],
  );

  return {
    layout,
    apply,
    setViewport,
    saveState,
    saveError,
    retrySave,
    restoreCount,
    loadError,
    blocked,
    allowOverwrite: useCallback(() => allowOverwrite(layoutRef.current ?? undefined), [allowOverwrite]),
    retryLoad,
    hadStoredLayout: hadStoredLayout.current,
  };
}
