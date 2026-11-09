import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { nativeCancellationHasNoLaterWork, nativeWorkEvents, stopAndRedirectThroughUi } from "./stop-redirect-flow.ts";
import { activeStopWorkBoundary, stoppedRunAccountingFinalized } from "./product-journeys/stop-redirect-evidence.ts";

const base = { id: "run", companyId: "company", agentId: "agent", nativeIssueId: "issue", runtimeMode: "native", status: "running",
  usageJson: { accountingReceiptSourceId: "source", accountingReceiptSequence: 5 } };
const event = (seq, type, payload = {}) => ({ seq, eventType: type, runId: base.id, companyId: base.companyId, agentId: base.agentId,
  protocolSchemaVersion: 1, sourceEventId: `event-${seq}`, sourceInstanceId: "runner", sourceSeq: seq,
  payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, eventType: type, runId: base.id, turnId: "turn",
    sourceKind: "runner", sourceEventId: `event-${seq}`, sourceInstanceId: "runner", sourceSeq: seq, payload } } });
const command = { schema: "paperclip.tool.execution.v1", executionId: "sleep", transport: "process", operation: "execute", status: "running" };
const usage = { kind: "usage", usage: { runDeltaComplete: true, runDelta: { inputTokens: 120, outputTokens: 10 } } };
let state = { phase: "startup", run: structuredClone(base), events: [event(1, "turn.started")] };
let beforeStop = false, beforeRedirect = false, stops = 0, replies = 0, cancelled = false, boundary, journey, beforeEvents;
const observed = new Set();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const until = async predicate => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert(Date.now() < deadline, "bounded observer did not advance");
    await new Promise(done => setTimeout(done, 10));
  }
};
const observe = async predicate => {
  const deadline = Date.now() + 3000;
  while (!cancelled && Date.now() < deadline) {
    const snapshot = await page.evaluate(async () => (await fetch("/api/owned-observation")).json());
    observed.add(snapshot.phase);
    const result = predicate(snapshot);
    if (result) return result;
    await new Promise(done => setTimeout(done, 10));
  }
  throw new Error("bounded controlled observation did not qualify");
};
try {
  await page.route("https://stop.fixture/**", route => route.request().url().endsWith("/api/owned-observation")
    ? route.fulfill({ contentType: "application/json", body: JSON.stringify(state) })
    : route.fulfill({ contentType: "text/html", body:
      '<button data-testid="task-chat-composer-stop" onclick="window.stopped()">Stop</button>' }));
  await page.exposeFunction("stopped", () => {
    stops++;
    state = { ...state, phase: "pending", events: [...state.events, event(7, "turn.cancelled")],
      run: { ...base, status: "cancelled", costAccountingPending: true,
      finishedAt: "2026-01-01T00:00:01Z", usageJson: { ...base.usageJson, accountingReceiptSequence: 6, accountingReceiptReady: false, accountingReceiptId: "receipt" } } };
  });
  await page.goto("https://stop.fixture/task");
  journey = stopAndRedirectThroughUi({ page, nonce: "fixture",
    beforeStop: async () => { beforeStop = true; boundary = await observe(s => activeStopWorkBoundary(s.run, s.events)); },
    awaitRetirement: async () => {
      assert.equal(stops, 1);
      beforeEvents = await observe(s => nativeCancellationHasNoLaterWork(s.events, boundary) && nativeWorkEvents(s.events, boundary));
    },
    beforeRedirect: async () => {
      beforeRedirect = true;
      const final = await observe(s => stoppedRunAccountingFinalized(s.run, boundary) && s);
      assert(nativeCancellationHasNoLaterWork(final.events, boundary));
      assert.deepEqual(nativeWorkEvents(final.events, boundary), beforeEvents);
    },
    reply: async () => { replies++; return { id: "owned-comment" }; },
  });
  journey.catch(() => undefined);
  await until(() => observed.has("startup") || stops > 0);
  assert.equal(stops, 0, "startup or incomplete usage must not click Stop");
  assert.equal(beforeStop, true);
  state = { ...state, phase: "command-only", events: [event(1, "turn.started"), event(2, "tool.execution.started", command)] };
  await until(() => observed.has("command-only")); assert.equal(stops, 0);
  state = { ...state, phase: "usage-only", events: [event(1, "turn.started"), event(2, "item.completed", usage)] };
  await until(() => observed.has("usage-only")); assert.equal(stops, 0);
  const partial = { kind: "usage", usage: { ...usage.usage, runDeltaComplete: false } };
  state = { ...state, phase: "partial-usage", events: [event(1, "turn.started"), event(2, "item.completed", partial), event(3, "tool.execution.started", command)] };
  await until(() => observed.has("partial-usage")); assert.equal(stops, 0);
  state = { ...state, phase: "hold-ended-before-usage", events: [event(1, "turn.started"), event(2, "tool.execution.started", command),
    event(3, "tool.execution.completed", { ...command, status: "completed" }), event(4, "item.completed", usage)] };
  await until(() => observed.has("hold-ended-before-usage")); assert.equal(stops, 0);
  const readiness = { ...command, executionId: "readiness" };
  state = { ...state, phase: "readiness-active", events: [event(1, "turn.started"), event(2, "tool.execution.started", readiness)] };
  await until(() => observed.has("readiness-active")); assert.equal(stops, 0);
  const readyUsage = [event(1, "turn.started"), event(2, "tool.execution.started", readiness),
    event(3, "tool.execution.completed", { ...readiness, status: "completed" }), event(4, "item.completed", { kind: "usage" }),
    event(5, "item.completed", usage)];
  state = { ...state, phase: "readiness-complete", events: readyUsage };
  await until(() => observed.has("readiness-complete")); assert.equal(stops, 0);
  state = { ...state, phase: "ready", events: [...readyUsage, event(6, "tool.execution.started", command)] };
  await until(() => beforeRedirect && observed.has("pending"));
  assert.equal(stops, 1); assert.equal(replies, 0, "Stop/lease proof cannot substitute for settled accounting");
  const raw = { kind: "usage", item: { type: "usage" }, text: "", channel: "usage" };
  const reconciled = event(8, "item.completed", raw);
  reconciled.sourceInstanceId = reconciled.payload.prpEvent.sourceInstanceId = "reconciler";
  state = { ...state, phase: "ready-but-pending", events: [...state.events, reconciled,
    event(9, "item.completed", partial), event(10, "item.completed", usage)],
    run: { ...state.run, usageJson: { ...state.run.usageJson, accountingReceiptReady: true } } };
  await until(() => observed.has("ready-but-pending")); assert.equal(replies, 0);
  const current = await page.evaluate(async () => (await fetch("/api/owned-observation")).json());
  for (const mutate of [row => { row.companyId = "foreign"; }, row => { row.agentId = "foreign"; },
    row => { row.payload.prpEvent.runId = "foreign"; }, row => { row.sourceEventId = "foreign"; },
    row => { row.sourceInstanceId = "foreign"; }, row => { row.sourceSeq++; }]) {
    const foreign = event(11, "item.completed", raw); mutate(foreign);
    assert.equal(nativeCancellationHasNoLaterWork([...current.events, foreign], boundary), false);
    assert.notDeepEqual(nativeWorkEvents([...current.events, foreign], boundary), beforeEvents);
  }
  for (const type of ["tool.execution.started", "message.delta", "item.delta"]) {
    const productive = event(11, type, { kind: "message" });
    productive.sourceInstanceId = productive.payload.prpEvent.sourceInstanceId = "reconciler";
    assert.equal(nativeCancellationHasNoLaterWork([...current.events, productive], boundary), false);
  }
  assert.equal(nativeCancellationHasNoLaterWork(current.events), false);
  state = { ...state, phase: "missing-accounted-time", run: { ...state.run, costAccountingPending: false } };
  await until(() => observed.has("missing-accounted-time")); assert.equal(replies, 0);
  state = { ...state, phase: "settled", run: { ...state.run, costAccountedAt: "2026-01-01T00:00:02Z" } };
  assert.equal((await journey).reply.id, "owned-comment");
  assert.equal(stops, 1); assert.equal(replies, 1);
  console.log("PASS: Chromium/controlled API rejects startup, command-only, usage-only, partial pre-Stop usage and a hold completed before its first usage; completed readiness usage plus a separate active hold permits one Stop; settled accounting permits one redirect; bound usage preserves work history and wrong bindings/productive output fail.");
} finally {
  cancelled = true;
  await journey?.catch(() => undefined);
  await browser.close();
}
