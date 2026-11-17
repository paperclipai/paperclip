import { describe, expect, it } from "vitest";
import { providerTurnStartBefore } from "./provider-turn-tool-order.js";

type Stored = [number, string, Record<string, unknown>?];

const start = (turnId: string, origin: string | null = "provider") =>
  ({ provider: "acpx", providerTurnId: turnId, status: "inProgress", turn: { id: turnId, status: "inProgress" }, ...(origin ? { origin } : {}) });
const terminal = (turnId: string | null) => ({ provider: "acpx", providerTurnId: turnId, status: "failed" });
const window = (stored: Stored[]) => stored.map(([sourceSeq, eventType, payload = {}]) =>
  ({ sourceSeq, eventType, envelope: { runId: "run-1", turnId: "turn-1", payload: { eventType, turnId: "turn-1", payload } } }));
const owner = (stored: Stored[], sourceSeq: number) => providerTurnStartBefore(window(stored), sourceSeq)?.turnId ?? null;

describe("providerTurnStartBefore", () => {
  it("returns the stored start when the window removed ordinary events after it", () => {
    expect(owner([[10, "turn.started", start("a")], [40, "item.completed"], [41, "item.completed"]], 41)).toBe("a");
  });

  it("returns the stored start across a dropped item delta", () => {
    expect(owner([[10, "turn.started", start("a")], [11, "item.started"], [13, "item.completed"]], 13)).toBe("a");
  });

  it("returns the start with its payload in the contiguous case", () => {
    expect(providerTurnStartBefore(window([[10, "turn.started", start("a")], [11, "item.started"]]), 12))
      .toEqual({ turnId: "a", payload: start("a") });
  });

  it("returns nothing for an event after the turn's own terminal", () => {
    expect(owner([[10, "turn.started", start("a")], [20, "turn.completed", terminal("a")], [21, "item.completed"]], 21)).toBeNull();
  });

  it("returns the start for an event before the turn's own terminal", () => {
    expect(owner([[10, "turn.started", start("a")], [15, "item.completed"], [20, "turn.completed", terminal("a")]], 15)).toBe("a");
  });

  it("returns the start for the turn's own terminal", () => {
    expect(owner([[10, "turn.started", start("a")], [20, "turn.interrupted", terminal("a")]], 20)).toBe("a");
  });

  it("returns nothing when the turn's terminal was removed and a startless terminal of another turn follows", () => {
    const stored: Stored[] = [[10, "turn.started", start("a")], [30, "harness.diagnostic"], [31, "session.resumed"], [32, "turn.failed", terminal("controller-b")], [33, "item.completed"]];
    expect(owner(stored, 30)).toBeNull();
    expect(owner(stored, 32)).toBeNull();
    expect(owner(stored, 33)).toBeNull();
  });

  it("returns nothing when the first terminal after the start names no turn", () => {
    expect(owner([[10, "turn.started", start("a")], [30, "item.completed"], [32, "turn.failed", terminal(null)]], 30)).toBeNull();
  });

  it("returns the start when its own terminal comes before a later foreign terminal", () => {
    expect(owner([[10, "turn.started", start("a")], [15, "item.completed"], [20, "turn.completed", terminal("a")], [25, "turn.failed", terminal("controller-b")]], 15)).toBe("a");
  });

  it("returns nothing when the nearest start is a controller start", () => {
    expect(owner([[10, "turn.started", start("a")], [20, "turn.completed", terminal("a")], [30, "turn.started", start("b", null)], [31, "item.completed"]], 31)).toBeNull();
  });

  it("returns nothing when no start is stored", () => {
    expect(owner([[30, "item.completed"], [31, "item.completed"]], 31)).toBeNull();
  });
});
