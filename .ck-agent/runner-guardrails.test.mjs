import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalQueueStopsRun,
  bindToolArguments,
  createToolRepeatGuard,
  dispositionForAgentResult,
  latestHumanRevisionFeedback,
  pendingHumanApproval,
  pluginToolExecutionContent,
} from "./runner-guardrails.mjs";

test("stops executing an identical tool call after two attempts", () => {
  const guard = createToolRepeatGuard(2);
  assert.deepEqual(guard.record("recall:{}"), { count: 1, execute: true });
  assert.deepEqual(guard.record("recall:{}"), { count: 2, execute: true });
  assert.deepEqual(guard.record("recall:{}"), { count: 3, execute: false });
  assert.deepEqual(guard.record("web_fetch:{\"url\":\"x\"}"), { count: 1, execute: true });
});

test("an explicit partial result can never receive a done disposition", () => {
  assert.equal(dispositionForAgentResult({ partial: true }), "in_review");
  assert.equal(dispositionForAgentResult({ text: "complete" }), "done");
});

test("approval drafts are always bound to the executing issue UUID", () => {
  assert.deepEqual(
    bindToolArguments(
      "queue_email_for_approval",
      { issue_id: "CK-364", subject: "Hello" },
      { issueId: "ea5f6b28-5da2-4098-a591-cd55f90a5f1b" },
    ),
    { issue_id: "ea5f6b28-5da2-4098-a591-cd55f90a5f1b", subject: "Hello" },
  );
  assert.deepEqual(bindToolArguments("review_draft", { text: "x" }, { issueId: "uuid" }), { text: "x" });
});

test("a queued or already-pending human approval stops the agent run", () => {
  assert.equal(approvalQueueStopsRun("queue_email_for_approval", { ok: true, queued: true }), true);
  assert.equal(approvalQueueStopsRun("queue_email_for_approval", { ok: true, awaiting_human: true }), true);
  assert.equal(approvalQueueStopsRun("queue_email_for_approval", { ok: false }), false);
  assert.equal(approvalQueueStopsRun("review_draft", { ok: true, queued: true }), false);
});

test("plugin tool execution unwraps the registered tool result content", () => {
  assert.equal(
    pluginToolExecutionContent({
      pluginId: "ck.evaluation-office",
      result: { content: "{\"ok\":true,\"queued\":true}", data: { ok: true } },
    }),
    "{\"ok\":true,\"queued\":true}",
  );
});

test("pending confirmation is recognized before model work begins", () => {
  const pending = { id: "decision-1", kind: "request_confirmation", status: "pending" };
  assert.equal(pendingHumanApproval([pending])?.id, "decision-1");
  assert.equal(
    pendingHumanApproval([{ ...pending, status: "accepted" }]),
    undefined,
  );
});

test("the latest Hold reason is preserved as revision feedback for the next run", () => {
  assert.equal(
    latestHumanRevisionFeedback([
      {
        status: "rejected",
        resolvedAt: "2026-07-19T10:00:00Z",
        result: { reason: "Use a neutral greeting." },
      },
      {
        status: "rejected",
        resolvedAt: "2026-07-19T11:00:00Z",
        result: { reason: "Use the sourced Bärenstube and Weinkeller fact." },
      },
      {
        status: "accepted",
        resolvedAt: "2026-07-19T12:00:00Z",
        result: { reason: "irrelevant" },
      },
    ]),
    "Use the sourced Bärenstube and Weinkeller fact.",
  );
  assert.equal(latestHumanRevisionFeedback([]), "");
});
