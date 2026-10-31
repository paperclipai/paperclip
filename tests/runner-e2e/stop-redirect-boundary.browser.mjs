import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { stopAndRedirectThroughUi } from "./stop-redirect-flow.ts";
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
let beforeStop = false, beforeRedirect = false, stops = 0, replies = 0, cancelled = false, boundary, journey;
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
    state = { ...state, phase: "pending", run: { ...base, status: "cancelled", costAccountingPending: true,
      finishedAt: "2026-01-01T00:00:01Z", usageJson: { ...base.usageJson, accountingReceiptSequence: 6, accountingReceiptReady: false, accountingReceiptId: "receipt" } } };
  });
  await page.goto("https://stop.fixture/task");
  journey = stopAndRedirectThroughUi({ page, nonce: "fixture",
    beforeStop: async () => { beforeStop = true; boundary = await observe(s => activeStopWorkBoundary(s.run, s.events)); },
    awaitRetirement: async () => assert.equal(stops, 1),
    beforeRedirect: async () => { beforeRedirect = true; await observe(s => stoppedRunAccountingFinalized(s.run, boundary)); },
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
  state = { ...state, phase: "ready", events: [event(1, "turn.started"), event(2, "item.completed", usage), event(3, "tool.execution.started", command)] };
  await until(() => beforeRedirect && observed.has("pending"));
  assert.equal(stops, 1); assert.equal(replies, 0, "Stop/lease proof cannot substitute for settled accounting");
  state = { ...state, phase: "ready-but-pending", run: { ...state.run, usageJson: { ...state.run.usageJson, accountingReceiptReady: true } } };
  await until(() => observed.has("ready-but-pending")); assert.equal(replies, 0);
  state = { ...state, phase: "missing-accounted-time", run: { ...state.run, costAccountingPending: false } };
  await until(() => observed.has("missing-accounted-time")); assert.equal(replies, 0);
  state = { ...state, phase: "settled", run: { ...state.run, costAccountedAt: "2026-01-01T00:00:02Z" } };
  assert.equal((await journey).reply.id, "owned-comment");
  assert.equal(stops, 1); assert.equal(replies, 1);
  console.log("PASS: Chromium/controlled API rejects startup, command-only, usage-only, incomplete accounting and missing timestamp; one Stop and redirect after genuine bound proof.");
} finally {
  cancelled = true;
  await journey?.catch(() => undefined);
  await browser.close();
}
