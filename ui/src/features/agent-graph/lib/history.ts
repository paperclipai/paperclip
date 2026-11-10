export type HistoryEntry<TDocument> =
  | { kind: "document"; before: TDocument; after: TDocument }
  | { kind: "reparent"; agentId: string; before: string | null; after: string | null };

export interface HistoryState<TDocument> {
  past: readonly HistoryEntry<TDocument>[];
  future: readonly HistoryEntry<TDocument>[];
}

export const HISTORY_LIMIT = 100;

export function emptyHistory<TDocument>(): HistoryState<TDocument> {
  return { past: [], future: [] };
}

export function pushHistory<TDocument>(
  state: HistoryState<TDocument>,
  entry: HistoryEntry<TDocument>,
  limit = HISTORY_LIMIT,
): HistoryState<TDocument> {
  const past = [...state.past, entry];
  return { past: past.length > limit ? past.slice(past.length - limit) : past, future: [] };
}

export function undoHistory<TDocument>(
  state: HistoryState<TDocument>,
): { state: HistoryState<TDocument>; entry: HistoryEntry<TDocument> | null } {
  const entry = state.past[state.past.length - 1];
  if (!entry) return { state, entry: null };
  return { state: { past: state.past.slice(0, -1), future: [...state.future, entry] }, entry };
}

export function redoHistory<TDocument>(
  state: HistoryState<TDocument>,
): { state: HistoryState<TDocument>; entry: HistoryEntry<TDocument> | null } {
  const entry = state.future[state.future.length - 1];
  if (!entry) return { state, entry: null };
  return { state: { past: [...state.past, entry], future: state.future.slice(0, -1) }, entry };
}

export type HistoryDirection = "undo" | "redo";

export function peekHistory<TDocument>(
  state: HistoryState<TDocument>,
  direction: HistoryDirection,
): HistoryEntry<TDocument> | null {
  const stack = direction === "undo" ? state.past : state.future;
  return stack[stack.length - 1] ?? null;
}

export function commitHistoryStep<TDocument>(
  state: HistoryState<TDocument>,
  direction: HistoryDirection,
): HistoryState<TDocument> {
  return (direction === "undo" ? undoHistory(state) : redoHistory(state)).state;
}

export function discardHistoryStep<TDocument>(
  state: HistoryState<TDocument>,
  direction: HistoryDirection,
): HistoryState<TDocument> {
  if (peekHistory(state, direction) === null) return state;
  return direction === "undo"
    ? { past: state.past.slice(0, -1), future: state.future }
    : { past: state.past, future: state.future.slice(0, -1) };
}

export function rewriteHistoryDocuments<TDocument>(
  state: HistoryState<TDocument>,
  rewrite: (document: TDocument) => TDocument,
  isSame: (a: TDocument, b: TDocument) => boolean,
): HistoryState<TDocument> {
  const rewriteStack = (stack: readonly HistoryEntry<TDocument>[]) => {
    const next: HistoryEntry<TDocument>[] = [];
    for (const entry of stack) {
      if (entry.kind !== "document") {
        next.push(entry);
        continue;
      }
      const before = rewrite(entry.before);
      const after = rewrite(entry.after);
      if (isSame(before, after)) continue;
      next.push(before === entry.before && after === entry.after ? entry : { kind: "document", before, after });
    }
    return next;
  };
  return { past: rewriteStack(state.past), future: rewriteStack(state.future) };
}
