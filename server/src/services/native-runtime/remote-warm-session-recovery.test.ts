import { describe, expect, it } from "vitest";
import { isSettledRemoteWarmControlState } from "./remote-warm-session-recovery.js";

const identity = { runId: "run", normalizedSessionId: "session", runnerInstanceId: "runner", environmentLeaseId: "lease", turnId: "turn", itemId: "item" };
const terminal = { eventType: "run.terminal", envelope: { ...identity } };
const goal = { schema: "paperclip.session_goal.snapshot.v1", goal: null, workingNow: false };
const notification = { schema: "paperclip.prp.event.v1", eventType: "session.goal.snapshot", runId: identity.runId,
  normalizedSessionId: identity.normalizedSessionId, sourceInstanceId: "runner", sourceKind: "runner", payload: goal };
const snapshot = { eventType: "session.goal.snapshot", envelope: { ...identity, payload: notification } };
const state = (events: unknown[]) => ({ identity, commands: [{ status: "completed" }], committedEvents: events });

describe("settled remote warm control evidence", () => {
  it.each(["paperclip.prp.event.v1", "paperclip.prp.event.v2"])("accepts the terminal and an authenticated %s idle goal-read suffix without changing its order", schema => {
    const suffix = { ...snapshot, envelope: { ...snapshot.envelope, payload: { ...notification, schema } } };
    const control = state([terminal, suffix]);
    expect(isSettledRemoteWarmControlState(control, identity)).toBe(true);
    expect(control.committedEvents).toEqual([terminal, suffix]);
    expect(isSettledRemoteWarmControlState(state([terminal]), identity)).toBe(true);
  });

  it.each([
    ["active goal", { ...snapshot, envelope: { ...snapshot.envelope, payload: { ...notification, payload: { ...goal, goal: { status: "active" } } } } }],
    ["provider work", { ...snapshot, envelope: { ...snapshot.envelope, payload: { ...notification, payload: { ...goal, workingNow: true } } } }],
    ["unknown event", { ...snapshot, eventType: "unknown" }],
    ["unknown protocol version", { ...snapshot, envelope: { ...snapshot.envelope, payload: { ...notification, schema: "paperclip.prp.event.v3" } } }],
    ["new turn", { ...snapshot, eventType: "turn.started" }],
    ["foreign run", { ...snapshot, envelope: { ...snapshot.envelope, runId: "other" } }],
    ["foreign session", { ...snapshot, envelope: { ...snapshot.envelope, normalizedSessionId: "other" } }],
    ["foreign source", { ...snapshot, envelope: { ...snapshot.envelope, payload: { ...notification, sourceInstanceId: "other" } } }],
    ["foreign lease", { ...snapshot, envelope: { ...snapshot.envelope, environmentLeaseId: "other" } }],
    ["foreign notification", { ...snapshot, envelope: { ...snapshot.envelope, payload: { ...notification, runId: "other" } } }],
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
