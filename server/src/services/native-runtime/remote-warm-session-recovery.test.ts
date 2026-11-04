import { describe, expect, it } from "vitest";
import { describeOwnFailedAttachment, isSettledRemoteWarmControlState, summarizePostTerminalEvents } from "./remote-warm-session-recovery.js";

const identity = { runId: "run", normalizedSessionId: "session", runnerInstanceId: "runner", environmentLeaseId: "lease", turnId: "turn", itemId: "item" };
const terminal = { eventType: "run.terminal", envelope: { ...identity } };
const goal = { schema: "paperclip.session_goal.snapshot.v1", goal: null, workingNow: false };
const notification = { schema: "paperclip.prp.event.v1", eventType: "session.goal.snapshot", runId: identity.runId,
  normalizedSessionId: identity.normalizedSessionId, sourceInstanceId: "runner", sourceKind: "runner", payload: goal };
const snapshot = { eventType: "session.goal.snapshot", envelope: { ...identity, payload: notification } };
const notice = { schema: "paperclip.provider.notice.v1", noticeId: "codex-warning", severity: "warning", category: "warning", scope: "turn",
  recoverable: true, userActionable: true, summary: "ignored a notification for a settled Codex turn" };
const noticeNotification = { ...notification, eventType: "provider.notice.recorded", payload: notice };
const lateNotice = { eventType: "provider.notice.recorded", envelope: { ...identity, payload: noticeNotification } };
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
    ["unauthenticated event type", { ...snapshot, eventType: "unknown" }],
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

  it("accepts anything that already happened after the terminal, whatever its severity or type", () => {
    const variant = (eventType: string, payload: Record<string, unknown>) =>
      ({ eventType, envelope: { ...lateNotice.envelope, payload: { ...noticeNotification, eventType, payload } } });
    const info = { ...lateNotice, envelope: { ...lateNotice.envelope, payload: { ...noticeNotification, payload: { ...notice, severity: "info" } } } };
    expect(isSettledRemoteWarmControlState(state([terminal, lateNotice]), identity)).toBe(true);
    expect(isSettledRemoteWarmControlState(state([terminal, lateNotice, snapshot, info]), identity)).toBe(true);
    for (const late of [
      variant("provider.notice.recorded", { ...notice, severity: "error", recoverable: false }),
      variant("harness.diagnostic", { code: "codex_resume_usage_snapshot" }),
      variant("usage.reported", { runDelta: { inputTokens: 1 } }),
      variant("a.future.event", {}),
    ]) expect(isSettledRemoteWarmControlState(state([terminal, late]), identity)).toBe(true);
  });

  it.each(["turn.started", "turn.accepted", "run.attached", "tool.execution.started", "semantic_tool.input", "runtime_request.created"])(
    "holds %s after the terminal because work may still be live", eventType => {
      const live = { eventType, envelope: { ...lateNotice.envelope, payload: { ...noticeNotification, eventType } } };
      expect(isSettledRemoteWarmControlState(state([terminal, lateNotice, live]), identity)).toBe(false);
    });

  it("summarizes post-terminal events for the next run's log", () => {
    expect(summarizePostTerminalEvents(state([terminal]))).toBeNull();
    expect(summarizePostTerminalEvents(state([terminal, lateNotice, lateNotice, snapshot])))
      .toBe("provider.notice.recorded x2, session.goal.snapshot x1");
  });

  it("names the original failure when a same-run retry finds its own failed attachment", () => {
    expect(describeOwnFailedAttachment([{ stderrTail: "run.attach requires a settled session: active_turn" }]))
      .toBe("runner_state_identity_mismatch: prior_attach_failed: run.attach requires a settled session: active_turn");
    expect(describeOwnFailedAttachment([])).toBe("runner_state_identity_mismatch: prior_attach_failed: unknown");
    expect(describeOwnFailedAttachment(undefined)).toBe("runner_state_identity_mismatch: prior_attach_failed: unknown");
  });

  it.each([
    ["notification type mismatch", { ...lateNotice, envelope: { ...lateNotice.envelope, payload: { ...noticeNotification, eventType: "session.goal.snapshot" } } }],
    ["foreign notice source", { ...lateNotice, envelope: { ...lateNotice.envelope, payload: { ...noticeNotification, sourceInstanceId: "other" } } }],
    ["foreign notice lease", { ...lateNotice, envelope: { ...lateNotice.envelope, environmentLeaseId: "other" } }],
    ["control plane notice source", { ...lateNotice, envelope: { ...lateNotice.envelope, payload: { ...noticeNotification, sourceKind: "control_plane" } } }],
  ])("holds a %s suffix", (_name, suffix) => {
    expect(isSettledRemoteWarmControlState(state([terminal, suffix]), identity)).toBe(false);
  });

  it("holds new work recorded after a late provider notice", () => {
    expect(isSettledRemoteWarmControlState(state([terminal, lateNotice, { ...snapshot, eventType: "turn.started" }]), identity)).toBe(false);
  });

  it("holds missing terminals, pending commands and mixed core identities", () => {
    expect(isSettledRemoteWarmControlState(state([snapshot]), identity)).toBe(false);
    expect(isSettledRemoteWarmControlState({ ...state([terminal, snapshot]), commands: [{ status: "dispatched" }] }, identity)).toBe(false);
    expect(isSettledRemoteWarmControlState({ ...state([terminal, snapshot]), identity: { ...identity, runnerInstanceId: "other" } }, identity)).toBe(false);
    expect(isSettledRemoteWarmControlState(state([{ ...terminal, envelope: { ...identity, runId: "other" } }, snapshot]), identity)).toBe(false);
  });
});
