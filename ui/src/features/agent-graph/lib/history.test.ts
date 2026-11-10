import { describe, expect, it } from "vitest";
import { emptyHistory, pushHistory, redoHistory, undoHistory, type HistoryEntry } from "./history";

const doc = (n: number): HistoryEntry<number> => ({ kind: "document", before: n - 1, after: n });

describe("graph history", () => {
  it("undoes and redoes in order", () => {
    let state = emptyHistory<number>();
    state = pushHistory(state, doc(1));
    state = pushHistory(state, { kind: "reparent", agentId: "a", before: "m1", after: "m2" });
    const first = undoHistory(state);
    expect(first.entry).toEqual({ kind: "reparent", agentId: "a", before: "m1", after: "m2" });
    const second = undoHistory(first.state);
    expect(second.entry).toEqual(doc(1));
    expect(undoHistory(second.state).entry).toBeNull();
    const redo = redoHistory(second.state);
    expect(redo.entry).toEqual(doc(1));
    expect(redo.state.past).toHaveLength(1);
    expect(redo.state.future).toHaveLength(1);
  });

  it("clears the redo stack on a new entry and caps the undo stack", () => {
    let state = emptyHistory<number>();
    state = pushHistory(state, doc(1));
    state = undoHistory(state).state;
    state = pushHistory(state, doc(2));
    expect(state.future).toHaveLength(0);
    for (let i = 0; i < 10; i += 1) state = pushHistory(state, doc(i), 3);
    expect(state.past.map((entry) => (entry.kind === "document" ? entry.after : null))).toEqual([7, 8, 9]);
  });
});
