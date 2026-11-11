import { useCallback, useEffect, useRef, useState } from "react";
import { resolveAgentGraphLayout, type AgentGraphLayout } from "@paperclipai/shared";
import { useUiLayout } from "@/hooks/useUiLayout";
import { defaultAgentGraphLayout } from "./lib/graph-nodes";
import {
  commitHistoryStep,
  discardHistoryStep,
  emptyHistory,
  peekHistory,
  pushHistory,
  rewriteHistoryDocuments,
  type HistoryDirection,
  type HistoryEntry,
  type HistoryState,
} from "./lib/history";

export type GraphHistoryEntry = HistoryEntry<AgentGraphLayout>;

export function useAgentGraphDocument(companyId: string) {
  const { stored, isLoaded, save, stage, saveState, saveError, retrySave, loadError, blocked, allowOverwrite, retryLoad } = useUiLayout({
    companyId,
    surface: "agent_graph",
    resolve: resolveAgentGraphLayout,
  });
  const [layout, setLayout] = useState<AgentGraphLayout | null>(null);
  const [history, setHistory] = useState<HistoryState<AgentGraphLayout>>(() => emptyHistory());
  const layoutRef = useRef<AgentGraphLayout | null>(null);
  const historyRef = useRef(history);
  const hadStoredLayout = useRef(false);
  const [restoreCount, setRestoreCount] = useState(0);

  const wasBlocked = useRef(false);

  useEffect(() => {
    if (!isLoaded) return;
    const recovered = wasBlocked.current && blocked === null && stored !== null;
    wasBlocked.current = blocked !== null;
    if (layoutRef.current && !recovered) return;
    hadStoredLayout.current = stored !== null;
    const initial = stored ?? defaultAgentGraphLayout();
    layoutRef.current = initial;
    setLayout(initial);
    if (recovered) {
      setRestoreCount((count) => count + 1);
      historyRef.current = emptyHistory();
      setHistory(historyRef.current);
    }
  }, [isLoaded, stored, blocked]);

  const write = useCallback(
    (next: AgentGraphLayout) => {
      layoutRef.current = next;
      setLayout(next);
      save(next);
    },
    [save],
  );

  const apply = useCallback(
    (update: (current: AgentGraphLayout) => AgentGraphLayout, options: { record?: boolean } = {}) => {
      const before = layoutRef.current;
      if (!before) return;
      const after = update(before);
      if (after === before) return;
      write(after);
      if (options.record !== false) {
        const next = pushHistory(historyRef.current, { kind: "document", before, after });
        historyRef.current = next;
        setHistory(next);
      }
    },
    [write],
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

  const replaceHistory = useCallback((next: HistoryState<AgentGraphLayout>) => {
    historyRef.current = next;
    setHistory(next);
  }, []);

  const recordReparent = useCallback(
    (agentId: string, before: string | null, after: string | null) => {
      replaceHistory(pushHistory(historyRef.current, { kind: "reparent", agentId, before, after }));
    },
    [replaceHistory],
  );

  const step = useCallback(
    (direction: HistoryDirection): GraphHistoryEntry | null => {
      const entry = peekHistory(historyRef.current, direction);
      if (!entry) return null;
      if (entry.kind === "reparent") return entry;
      replaceHistory(commitHistoryStep(historyRef.current, direction));
      const current = layoutRef.current;
      if (current) {
        const target = direction === "undo" ? entry.before : entry.after;
        write({ ...target, viewport: current.viewport });
      }
      return entry;
    },
    [write, replaceHistory],
  );

  const settleReparentStep = useCallback(
    (direction: HistoryDirection, outcome: "applied" | "invalid") => {
      if (peekHistory(historyRef.current, direction)?.kind !== "reparent") return;
      replaceHistory(
        outcome === "applied"
          ? commitHistoryStep(historyRef.current, direction)
          : discardHistoryStep(historyRef.current, direction),
      );
    },
    [replaceHistory],
  );

  const purgeDraft = useCallback(
    (draftId: string) => {
      const withoutDraft = (document: AgentGraphLayout): AgentGraphLayout =>
        document.drafts.some((draft) => draft.id === draftId)
          ? { ...document, drafts: document.drafts.filter((draft) => draft.id !== draftId) }
          : document;
      const sameContent = (a: AgentGraphLayout, b: AgentGraphLayout) =>
        a === b || JSON.stringify({ ...a, viewport: null }) === JSON.stringify({ ...b, viewport: null });
      replaceHistory(rewriteHistoryDocuments(historyRef.current, withoutDraft, sameContent));
      const current = layoutRef.current;
      if (!current) return;
      const next = withoutDraft(current);
      if (next !== current) write(next);
    },
    [write, replaceHistory],
  );

  return {
    layout,
    apply,
    setViewport,
    recordReparent,
    settleReparentStep,
    purgeDraft,
    undo: useCallback(() => step("undo"), [step]),
    redo: useCallback(() => step("redo"), [step]),
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    saveState,
    saveError,
    retrySave,
    restoreCount,
    loadError,
    blocked,
    allowOverwrite,
    retryLoad,
    hadStoredLayout: hadStoredLayout.current,
  };
}
