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
  const { stored, isLoaded, save, stage, flush, saveState, saveError, retrySave, loadError, blocked, allowOverwrite, retryLoad, owner } = useUiLayout({
    companyId,
    surface: "agent_graph",
    resolve: resolveAgentGraphLayout,
  });
  const [layout, setLayout] = useState<AgentGraphLayout | null>(null);
  const [history, setHistory] = useState<HistoryState<AgentGraphLayout>>(() => emptyHistory());
  const layoutRef = useRef<AgentGraphLayout | null>(null);
  const historyRef = useRef(history);
  const groupRef = useRef<{ key: string; entry: GraphHistoryEntry } | null>(null);
  const hadStoredLayout = useRef(false);
  const [restoreCount, setRestoreCount] = useState(0);

  const wasBlocked = useRef(false);
  const loadedOwner = useRef<string | null>(null);
  const ownerReload = useRef(false);
  const [layoutOwner, setLayoutOwner] = useState<string | null>(null);

  useEffect(() => {
    if (loadedOwner.current !== owner) {
      if (loadedOwner.current !== null) {
        layoutRef.current = null;
        setLayout(null);
        ownerReload.current = true;
      }
      loadedOwner.current = owner;
    }
    if (!isLoaded) return;
    const recovered = wasBlocked.current && blocked === null && stored !== null;
    wasBlocked.current = blocked !== null;
    if (layoutRef.current && !recovered) return;
    hadStoredLayout.current = stored !== null;
    const initial = stored ?? defaultAgentGraphLayout();
    layoutRef.current = initial;
    setLayout(initial);
    setLayoutOwner(owner);
    if (recovered || ownerReload.current) {
      setRestoreCount((count) => count + 1);
      historyRef.current = emptyHistory();
      setHistory(historyRef.current);
    }
    ownerReload.current = false;
  }, [isLoaded, stored, blocked, owner]);

  const write = useCallback(
    (next: AgentGraphLayout) => {
      layoutRef.current = next;
      setLayout(next);
      save(next);
    },
    [save],
  );

  const apply = useCallback(
    (update: (current: AgentGraphLayout) => AgentGraphLayout, options: { record?: boolean; group?: string } = {}) => {
      const before = layoutRef.current;
      if (!before) return;
      const after = update(before);
      if (after === before) return;
      write(after);
      if (options.record === false) return;
      const past = historyRef.current.past;
      const open = groupRef.current;
      const merged = options.group !== undefined && open !== null && open.key === options.group
        && past[past.length - 1] === open.entry && open.entry.kind === "document"
        ? open.entry
        : null;
      const entry: GraphHistoryEntry = { kind: "document", before: merged ? merged.before : before, after };
      const next = pushHistory(merged ? { past: past.slice(0, -1), future: [] } : historyRef.current, entry);
      groupRef.current = options.group === undefined ? null : { key: options.group, entry };
      historyRef.current = next;
      setHistory(next);
    },
    [write],
  );

  const closeGroup = useCallback(() => {
    groupRef.current = null;
  }, []);

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
    groupRef.current = null;
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
    layout: layoutOwner === owner ? layout : null,
    apply,
    closeGroup,
    flush,
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
    allowOverwrite: useCallback(() => allowOverwrite(layoutRef.current ?? undefined), [allowOverwrite]),
    retryLoad,
    hadStoredLayout: hadStoredLayout.current,
  };
}
