import { expect, it } from "vitest";
import { taskReplyBelongsToRun, uniqueBoundTaskReply, type TaskReplyObservation } from "./native-task-reply.js";

const run = { id: "final-run", companyId: "owned-company", agentId: "owned-agent", status: "succeeded", runtimeMode: "native", resultJson: {} };
const observed: TaskReplyObservation = { body: "The exact final reply", anchor: "final-run:turn", settled: true, nativeFinal: true, visible: true };
function events() {
  return [{ seq: 1, runId: run.id, companyId: run.companyId, agentId: run.agentId, eventType: "item.completed", protocolSchemaVersion: 1,
    sourceEventId: "event", sourceInstanceId: "instance", sourceSeq: 1,
    payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, runId: run.id, sourceKind: "runner", eventType: "item.completed",
      sourceEventId: "event", sourceInstanceId: "instance", sourceSeq: 1, payload: { kind: "agentMessage", channel: "final", text: observed.body } } } }];
}

it("binds a settled native final reply to its actual run without inventing a comment", () => {
  expect(taskReplyBelongsToRun(observed, run, "owned-agent", [], events())).toBe(true);
  for (const change of [{ anchor: "earlier-run:turn" }, { anchor: "final-run:turnish" }, { settled: false }, { nativeFinal: false }, { visible: false }, { body: "" }])
    expect(taskReplyBelongsToRun({ ...observed, ...change }, run, "owned-agent", [], events())).toBe(false);
  for (const change of [{ agentId: "other-agent" }, { status: "cancelled" }, { runtimeMode: "legacy" }])
    expect(taskReplyBelongsToRun(observed, { ...run, ...change }, "owned-agent", [], events())).toBe(false);
});

it("requires one exact visible answer and rejects duplicates, stale answers and extra text", () => {
  expect(uniqueBoundTaskReply([observed], run, "owned-agent", [], observed.body, events())).toEqual(observed);
  for (const all of [[], [observed, observed], [{ ...observed, body: observed.body + " extra" }],
    [{ ...observed, anchor: "old:turn" }], [observed, { ...observed, anchor: "old:turn" }]])
    expect(uniqueBoundTaskReply(all, run, "owned-agent", [], observed.body, events())).toBeNull();
});

it("accepts item-normalized final messages but rejects contradictory payload fields", () => {
  const copy: any[] = events();
  const payload = copy[0].payload.prpEvent.payload;
  payload.item = { type: payload.kind, channel: payload.channel, text: payload.text };
  delete payload.kind; delete payload.channel; delete payload.text;
  expect(taskReplyBelongsToRun(observed, run, "owned-agent", [], copy)).toBe(true);
  for (const change of [{ kind: "tool_call" }, { channel: "commentary" }, { text: "other reply" }]) {
    expect(taskReplyBelongsToRun(observed, run, "owned-agent", [], [{ ...copy[0], payload: { prpEvent: {
      ...copy[0].payload.prpEvent, payload: { ...payload, ...change },
    } } }])).toBe(false);
  }
});

it("rejects a rendered finish summary with no durable final assistant message", () => {
  const summaryOnly = { ...run, resultJson: { nativeResult: { summary: observed.body } } };
  expect(taskReplyBelongsToRun(observed, summaryOnly, "owned-agent", [])).toBe(false);
  const changes = [
    (e: ReturnType<typeof events>[number]) => { e.runId = "other"; },
    (e: ReturnType<typeof events>[number]) => { e.companyId = "other"; },
    (e: ReturnType<typeof events>[number]) => { e.agentId = "other"; },
    (e: ReturnType<typeof events>[number]) => { e.protocolSchemaVersion = 99; },
    (e: ReturnType<typeof events>[number]) => { e.payload.prpEvent.sourceKind = "control_plane"; },
    (e: ReturnType<typeof events>[number]) => { e.payload.prpEvent.payload.channel = "commentary"; },
    (e: ReturnType<typeof events>[number]) => { e.payload.prpEvent.payload.text = "different reply"; },
    (e: ReturnType<typeof events>[number]) => { e.sourceSeq = 2; },
  ];
  for (const change of changes) { const copy = events(); change(copy[0]!); expect(taskReplyBelongsToRun(observed, run, "owned-agent", [], copy)).toBe(false); }
  expect(taskReplyBelongsToRun(observed, run, "owned-agent", [], [...events(), ...events()])).toBe(false);
});

it("requires the selected, attributed completion comment when a presentation decision exists", () => {
  const published = { ...run, resultJson: { presentationDecision: { commentId: "selected" } } };
  const comment = { id: "selected", authorAgentId: "owned-agent", createdByRunId: "final-run", body: observed.body };
  const bubble = { ...observed, anchor: "selected", nativeFinal: false, settled: false };
  expect(taskReplyBelongsToRun(bubble, published, "owned-agent", [comment])).toBe(true);
  expect(taskReplyBelongsToRun(observed, published, "owned-agent", [comment])).toBe(false);
  for (const change of [{ id: "other" }, { authorAgentId: "other-agent" }, { createdByRunId: "earlier-run" }, { body: "wrong reply" }])
    expect(taskReplyBelongsToRun(bubble, published, "owned-agent", [{ ...comment, ...change }])).toBe(false);
  expect(taskReplyBelongsToRun(bubble, published, "owned-agent", [])).toBe(false);
});

it("accepts a proven native final before the selected comment is projected, and when comment creation is suppressed", () => {
  for (const presentationDecision of [{ commentId: "not-yet-projected", commentAction: "create" }, { commentId: null, commentAction: "none" }]) {
    const pendingProjection = { ...run, resultJson: { presentationDecision } };
    expect(taskReplyBelongsToRun(observed, pendingProjection, "owned-agent", [], events())).toBe(true);
    expect(taskReplyBelongsToRun(observed, pendingProjection, "owned-agent", [])).toBe(false);
  }
});

it("binds complete Markdown content and the exact link destination despite a decorated issue label", () => {
  const body = "I **couldn't retrieve** the pages. See [Connection outcome](/QA/issues/QA-123#document-outcome).";
  const comment = { id: "selected", authorAgentId: "owned-agent", createdByRunId: "final-run", body };
  const published = { ...run, resultJson: { presentationDecision: { commentId: "selected" } } };
  const bubble: TaskReplyObservation = { ...observed, anchor: "selected", origin: "https://fixture.test", pageUrl: "https://fixture.test/QA/issues/QA-123",
    body: "I couldn't retrieve the pages. See QA-123.",
    content: [{ text: "I couldn't retrieve the pages. See " }, { href: "https://fixture.test/QA/issues/QA-123#document-outcome", label: "QA-123", decorated: true }, { text: "." }] };
  expect(taskReplyBelongsToRun(bubble, published, "owned-agent", [comment])).toBe(true);
  const copy = events(); copy[0]!.payload.prpEvent.payload.text = body;
  expect(taskReplyBelongsToRun({ ...bubble, anchor: "final-run:turn" }, run, "owned-agent", [], copy)).toBe(true);
  expect(taskReplyBelongsToRun({ ...bubble, body: "Different visible response" }, published, "owned-agent", [comment])).toBe(false);
  for (const content of [undefined, [{ text: bubble.body }], [...bubble.content!, { text: " extra" }],
    [{ text: "I couldn't retrieve the pages. See " }, { href: "/other-task", label: "QA-123" }, { text: "." }]])
    expect(taskReplyBelongsToRun({ ...bubble, content }, published, "owned-agent", [comment])).toBe(false);
});
