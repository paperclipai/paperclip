import { expect, it } from "vitest";
import { taskReplyBelongsToRun, uniqueBoundTaskReply, type TaskReplyObservation } from "./native-task-reply.js";

const run = { id: "final-run", agentId: "owned-agent", status: "succeeded", runtimeMode: "native", resultJson: {} };
const observed: TaskReplyObservation = { body: "The exact final reply", anchor: "final-run:turn", settled: true, nativeFinal: true, visible: true };

it("binds a settled native final reply to its actual run without inventing a comment", () => {
  expect(taskReplyBelongsToRun(observed, run, "owned-agent", [])).toBe(true);
  for (const change of [{ anchor: "earlier-run:turn" }, { anchor: "final-run:turnish" }, { settled: false }, { nativeFinal: false }, { visible: false }, { body: "" }])
    expect(taskReplyBelongsToRun({ ...observed, ...change }, run, "owned-agent", [])).toBe(false);
  for (const change of [{ agentId: "other-agent" }, { status: "cancelled" }, { runtimeMode: "legacy" }])
    expect(taskReplyBelongsToRun(observed, { ...run, ...change }, "owned-agent", [])).toBe(false);
});

it("requires one exact visible answer and rejects duplicates, stale answers and extra text", () => {
  expect(uniqueBoundTaskReply([observed], run, "owned-agent", [], observed.body)).toEqual(observed);
  for (const all of [[], [observed, observed], [{ ...observed, body: observed.body + " extra" }],
    [{ ...observed, anchor: "old:turn" }], [observed, { ...observed, anchor: "old:turn" }]])
    expect(uniqueBoundTaskReply(all, run, "owned-agent", [], observed.body)).toBeNull();
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
