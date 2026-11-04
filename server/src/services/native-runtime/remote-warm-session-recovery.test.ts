import { describe, expect, it } from "vitest";
import { describeFailedAttachment, describeOwnFailedAttachment, isSettledRemoteWarmControlState, summarizePostTerminalEvents } from "./remote-warm-session-recovery.js";

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

  it("reads goal state from both goal events", () => {
    const goalEvent = (eventType: string, payload: Record<string, unknown>) =>
      ({ eventType, envelope: { ...identity, payload: { ...notification, eventType, payload: { ...goal, ...payload } } } });
    for (const eventType of ["session.goal.snapshot", "session.goal.updated"]) {
      const settled = (payload: Record<string, unknown>) => isSettledRemoteWarmControlState(state([terminal, goalEvent(eventType, payload)]), identity);
      expect(settled({ goal: { status: "active" } })).toBe(false);
      expect(settled({ goal: { status: "paused" }, workingNow: true })).toBe(false);
      expect(settled({ goal: null, workingNow: undefined })).toBe(false);
      expect(settled({ goal: { status: "paused" } })).toBe(true);
      expect(settled({ goal: { status: "complete" } })).toBe(true);
      expect(settled({})).toBe(true);
    }
  });

  it("summarizes post-terminal events for the next run's log", () => {
    expect(summarizePostTerminalEvents(state([terminal]))).toBeNull();
    expect(summarizePostTerminalEvents(state([terminal, lateNotice, lateNotice, snapshot])))
      .toBe("provider.notice.recorded x2, session.goal.snapshot x1");
  });

  it("points a failed attachment at the reviewed docs with its real cause", () => {
    const stored = 'native_session_recovery_failed: Error: PRP command run.attach failed: {"commandType":"run.attach","result":{"code":"command_execution_failed","message":"run.attach requires a settled Codex provider session: active_turn"},"status":"failed"}';
    const pointer = describeFailedAttachment(stored);
    expect(pointer).toContain("run.attach requires a settled Codex provider session: active_turn");
    expect(pointer).toContain("https://github.com/paperclipai/paperclip/blob/master/doc/execution-semantics.md#session-settlement-after-a-run");
    expect(describeFailedAttachment("run.attach requires the restored Codex provider process")).toContain("restored Codex provider process");
    expect(describeFailedAttachment("Plugin Runner operation failed; reconcile the saved task")).toBeNull();
    expect(describeFailedAttachment(null)).toBeNull();
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
