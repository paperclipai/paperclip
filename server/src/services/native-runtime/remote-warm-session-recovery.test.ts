import { describe, expect, it } from "vitest";
import { isSettledRemoteWarmControlState } from "./remote-warm-session-recovery.js";

const identity = { runId: "run", normalizedSessionId: "session", runnerInstanceId: "runner", environmentLeaseId: "lease", turnId: "turn", itemId: "item" };
const terminal = { eventType: "run.terminal", envelope: { ...identity } };
const snapshot = { eventType: "session.goal.snapshot", envelope: { ...identity, sourceInstanceId: "runner", sourceKind: "runner",
  payload: { schema: "paperclip.session_goal.snapshot.v1", goal: null, workingNow: false } } };
const state = (events: unknown[]) => ({ identity, commands: [{ status: "completed" }], committedEvents: events });

describe("settled remote warm control evidence", () => {
  it("accepts the terminal and an authenticated idle goal-read suffix without changing its order", () => {
    const control = state([terminal, snapshot]);
    expect(isSettledRemoteWarmControlState(control, identity)).toBe(true);
    expect(control.committedEvents).toEqual([terminal, snapshot]);
    expect(isSettledRemoteWarmControlState(state([terminal]), identity)).toBe(true);
  });

  it.each([
    ["active goal", { ...snapshot, envelope: { ...snapshot.envelope, payload: { ...snapshot.envelope.payload, goal: { status: "active" } } } }],
    ["provider work", { ...snapshot, envelope: { ...snapshot.envelope, payload: { ...snapshot.envelope.payload, workingNow: true } } }],
    ["unknown event", { ...snapshot, eventType: "unknown" }],
    ["new turn", { ...snapshot, eventType: "turn.started" }],
    ["foreign run", { ...snapshot, envelope: { ...snapshot.envelope, runId: "other" } }],
    ["foreign session", { ...snapshot, envelope: { ...snapshot.envelope, normalizedSessionId: "other" } }],
    ["foreign source", { ...snapshot, envelope: { ...snapshot.envelope, sourceInstanceId: "other" } }],
    ["missing payload", { ...snapshot, envelope: { ...identity } }],
  ])("holds a %s suffix", (_name, suffix) => {
    expect(isSettledRemoteWarmControlState(state([terminal, suffix]), identity)).toBe(false);
  });

  it("holds missing terminals, pending commands and mixed core identities", () => {
    expect(isSettledRemoteWarmControlState(state([snapshot]), identity)).toBe(false);
    expect(isSettledRemoteWarmControlState({ ...state([terminal, snapshot]), commands: [{ status: "dispatched" }] }, identity)).toBe(false);
    expect(isSettledRemoteWarmControlState({ ...state([terminal, snapshot]), identity: { ...identity, runnerInstanceId: "other" } }, identity)).toBe(false);
    expect(isSettledRemoteWarmControlState(state([{ ...terminal, envelope: { ...identity, runId: "other" } }, snapshot]), identity)).toBe(false);
  });
});
