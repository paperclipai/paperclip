import assert from "node:assert/strict";
import { it } from "vitest";
import { gradeHiringTemplateTurns, HIRING_TEMPLATE_TURN_ACCOUNTING_VERSION,
  type HiringTemplateTurnPredicateId } from "./hiring-template-turn-accounting.js";
import { createHiringTemplateTurnFixture as fixture, hiringTurnFixtureTimestamp as timestamp } from "./hiring-template-turn-fixture.js";

type Fixture = ReturnType<typeof fixture>;
type FixtureContext = Fixture["evidence"]["runs"][number]["contextSnapshot"];
const e = (f: Fixture) => f.evidence;
const notification = (f: Fixture) => e(f).runs.find(r => r.id === "notify-1")!;
const worker = (f: Fixture) => e(f).runs.find(r => r.id === "worker-first")!;
const request = (f: Fixture) => e(f).runs.find(r => r.id === "lead-first")!;
const sync = (f: Fixture) => { f.apiState.runs = structuredClone(e(f).runs); return f; };
const fails = (f: { evidence: unknown; apiState: unknown }, predicate?: HiringTemplateTurnPredicateId) => {
  const result = gradeHiringTemplateTurns(f);
  assert.equal(result.passed, false);
  assert.equal(result.predicates.length, 12);
  if (predicate) assert.equal(result.predicates.find(p => p.id === predicate)?.passed, false, predicate);
};

// Public positive and negative lifecycle cases ported from the published v1
// retained-evidence sidecar. Its original-grade/provenance wrapper stays separate.
for (const [count, label] of [[0, "five exact work turns"], [1, "six runs with one batched completion"], [2, "seven runs with distinct completions"]] as const) {
  it(`accepts ${label} while counting every run toward costs`, () => {
    const result = gradeHiringTemplateTurns(fixture(count));
    assert.equal(result.passed, true);
    assert.equal(result.version, HIRING_TEMPLATE_TURN_ACCOUNTING_VERSION);
    assert.equal(result.predicates.length, 12);
    assert.ok(result.predicates.every(predicate => predicate.passed));
    assert.deepEqual(result.counts, { requiredWorkTurns: 5, maximumCompletionTurns: 2, maximumTotalTurns: 7,
      requestedLeadTurns: 3, coderTurns: 2, completionTurns: count, unclassifiedTurns: 0,
      snapshotRunCount: 5 + count, actualRunCount: 5 + count, costAccountingRunCount: 5 + count });
    assert.deepEqual(Object.keys(result).sort(), ["actionEvidence", "counts", "passed", "predicates", "version"]);
  });
}

const negatives: Array<[string, (f: Fixture) => void, HiringTemplateTurnPredicateId]> = [
  ["an eighth run", f => { e(f).runs.push({ ...structuredClone(notification(f)), id: "extra" }); }, "exact-five-required-work-turns"],
  ["a duplicate run ID", f => { e(f).runs.push(structuredClone(notification(f))); }, "complete-public-run-ledger"],
  ["an arbitrary chat wake", f => { notification(f).contextSnapshot.wakeReason = "heartbeat_timer"; }, "exact-five-required-work-turns"],
  ["a completion label on a coder run", f => { notification(f).agentId = "coder"; }, "exact-five-required-work-turns"],
  ["an extra requested lead turn", f => { e(f).runs.push({ ...structuredClone(request(f)), id: "lead-extra" }); }, "exact-five-required-work-turns"],
  ["an extra coder execution", f => { e(f).runs.push({ ...structuredClone(worker(f)), id: "worker-extra" }); }, "exact-five-required-work-turns"],
  ["a missing requested lead turn", f => { e(f).runs = e(f).runs.filter(r => r.id !== "lead-status"); }, "exact-five-required-work-turns"],
  ["a missing coder execution", f => { e(f).runs = e(f).runs.filter(r => r.id !== "worker-first"); }, "exact-five-required-work-turns"],
  ["a missing production lead identity", f => { e(f).agents[0].id = "other"; }, "known-fixture-context"],
  ["a failed notification", f => { notification(f).status = "failed"; }, "successful-native-without-retries"],
  ["a legacy notification runtime", f => { notification(f).runtimeMode = "legacy"; }, "successful-native-without-retries"],
  ["a retried notification", f => { notification(f).retryOfRunId = "prior"; }, "successful-native-without-retries"],
  ["hidden process retries", f => { notification(f).processLossRetryCount = 1; }, "successful-native-without-retries"],
  ["a scheduled retry", f => { notification(f).scheduledRetryAttempt = 1; }, "successful-native-without-retries"],
  ["a continuation run", f => { notification(f).continuationAttempt = 1; }, "successful-native-without-retries"],
  ["a run in another company", f => { notification(f).companyId = "other"; }, "resolved-company-account-and-identity"],
  ["a wrong managed account", f => { notification(f).contextSnapshot.aiConnection.connectionId = "other"; }, "resolved-company-account-and-identity"],
  ["a wrong provider", f => { worker(f).contextSnapshot.aiConnection.provider = "other"; }, "resolved-company-account-and-identity"],
  ["a wrong auth method", f => { worker(f).contextSnapshot.aiConnection.method = "host"; }, "resolved-company-account-and-identity"],
  ["a wrong responsible-user binding", f => { notification(f).contextSnapshot.aiConnection.responsibleUserId = "other"; }, "resolved-company-account-and-identity"],
  ["a wrong run responsible user", f => { request(f).responsibleUserId = "other"; }, "resolved-company-account-and-identity"],
  ["an accepted foreign identity", f => { notification(f).identityHistory[0].responsibleUserId = "other"; }, "resolved-company-account-and-identity"],
  ["an identity receipt for another run", f => { notification(f).identityHistory[0].runId = "other"; }, "resolved-company-account-and-identity"],
  ["a missing instruction receipt", f => { request(f).identityHistory.pop(); }, "three-distinct-requested-chat-turns"],
  ["a rejected instruction receipt", f => { request(f).identityHistory[1].status = "rejected"; }, "three-distinct-requested-chat-turns"],
  ["a wrong instruction comment", f => { request(f).identityHistory[1].messageId = "other"; }, "three-distinct-requested-chat-turns"],
  ["a forged request author", f => { f.apiState.comments[0].authorUserId = "other"; }, "three-distinct-requested-chat-turns"],
  ["an additional user request", f => { f.apiState.comments.push({ ...f.apiState.comments[0], id: "request-extra" }); }, "three-distinct-requested-chat-turns"],
  ["two runs for one request comment", f => { e(f).runs.find(r => r.id === "lead-reuse")!.contextSnapshot.wakeCommentId = "request-1"; }, "three-distinct-requested-chat-turns"],
  ["a different requested chat generation", f => { request(f).contextSnapshot.conversationSessionGeneration = 1; }, "three-distinct-requested-chat-turns"],
  ["a worker assigned to another agent", f => { e(f).tasks[0].assigneeAgentId = "other"; }, "one-coder-execution-per-known-task"],
  ["a task outside the selected project", f => { e(f).tasks[0].projectId = "other"; }, "one-coder-execution-per-known-task"],
  ["a notification-created task", f => { e(f).tasks[0].originRunId = notification(f).id; }, "no-notification-created-extra-tasks"],
  ["a task created by the status-only turn", f => { e(f).tasks[0].originRunId = "lead-status"; }, "task-origins-are-first-two-requested-turns"],
  ["an extra task without an execution", f => { e(f).tasks.push({ ...e(f).tasks[0], id: "extra-task" }); }, "no-notification-created-extra-tasks"],
  ["a wake without delivery IDs", f => { delete notification(f).contextSnapshot.chatCompletionDeliveryIds; }, "bounded-server-completion-receipts"],
  ["a wake without task updates", f => { delete notification(f).contextSnapshot.chatCompletionUpdates; }, "bounded-server-completion-receipts"],
  ["mismatched receipt cardinality", f => { notification(f).contextSnapshot.chatCompletionDeliveryIds!.push("extra-delivery"); }, "bounded-server-completion-receipts"],
  ["a duplicate delivery across runs", f => { e(f).runs.find(r => r.id === "notify-2")!.contextSnapshot.chatCompletionDeliveryIds = notification(f).contextSnapshot.chatCompletionDeliveryIds; }, "bounded-server-completion-receipts"],
  ["a duplicate task notification with a fresh delivery ID", f => { e(f).runs.find(r => r.id === "notify-2")!.contextSnapshot.chatCompletionUpdates = structuredClone(notification(f).contextSnapshot.chatCompletionUpdates); }, "bounded-server-completion-receipts"],
  ["an unknown notified task", f => { notification(f).contextSnapshot.chatCompletionUpdates![0].id = "unknown"; }, "bounded-server-completion-receipts"],
  ["a pre-completion wake", f => { notification(f).startedAt = timestamp(10); }, "bounded-server-completion-receipts"],
  ["a false completedAt receipt", f => { notification(f).contextSnapshot.chatCompletionUpdates![0].completedAt = timestamp(10); }, "bounded-server-completion-receipts"],
  ["a false task identifier", f => { notification(f).contextSnapshot.chatCompletionUpdates![0].identifier = "OTHER-1"; }, "bounded-server-completion-receipts"],
  ["a wrong task link", f => { notification(f).contextSnapshot.chatCompletionUpdates![0].url = "/issues/OTHER-1"; }, "bounded-server-completion-receipts"],
  ["a false task status", f => { notification(f).contextSnapshot.chatCompletionUpdates![0].status = "in_progress"; }, "bounded-server-completion-receipts"],
  ["a task without a saved result", f => { notification(f).contextSnapshot.chatCompletionUpdates![0].hasSavedDocuments = false; }, "bounded-server-completion-receipts"],
  ["a stale completion generation", f => { notification(f).contextSnapshot.conversationSessionGeneration = 1; }, "bounded-server-completion-receipts"],
  ["a manually invoked completion label", f => { notification(f).invocationSource = "on_demand"; }, "bounded-server-completion-receipts"],
  ["a mixed request/completion wake", f => { notification(f).contextSnapshot.wakeCommentId = "request-1"; }, "bounded-server-completion-receipts"],
  ["a missing completion dispatch identity", f => { notification(f).identityHistory = []; }, "bounded-server-completion-receipts"],
  ["a missing completion reply", f => { f.apiState.comments = f.apiState.comments.filter(c => c.id !== "reply-1"); }, "completion-runs-have-attributed-chat-replies"],
  ["a reply attributed to a different run", f => { f.apiState.comments.find(c => c.id === "reply-1")!.createdByRunId = "lead-first"; }, "completion-runs-have-attributed-chat-replies"],
  ["a reply by another agent", f => { f.apiState.comments.find(c => c.id === "reply-1")!.authorAgentId = "coder"; }, "completion-runs-have-attributed-chat-replies"],
  ["a reply in another chat", f => { f.apiState.comments.find(c => c.id === "reply-1")!.issueId = "other"; }, "completion-runs-have-attributed-chat-replies"],
  ["a reply before task completion", f => { f.apiState.comments.find(c => c.id === "reply-1")!.createdAt = timestamp(10); }, "completion-runs-have-attributed-chat-replies"],
];
for (const [label, mutate, predicate] of negatives) it(`rejects ${label}`, () => {
  const f = fixture(); mutate(f); fails(sync(f), predicate);
});
it("rejects extra runs present only in the final public ledger and counts their cost", () => {
  const f = fixture(); f.apiState.runs.push({ ...structuredClone(notification(f)), id: "extra" });
  fails(f, "complete-public-run-ledger");
  assert.equal(gradeHiringTemplateTurns(f).counts.costAccountingRunCount, 8);
});
it("rejects an account discrepancy between retained ledgers", () => {
  const f = fixture(); f.apiState.runs[0]!.contextSnapshot.aiConnection.method = "host";
  fails(f, "complete-public-run-ledger");
});
it("does not require a prior grade, artifact outcome, source coverage or report provenance", () => {
  const f = fixture();
  assert.equal(gradeHiringTemplateTurns({ ...f, result: { outcomePassed: false, comparisonStatus: "uncomparable" } } as typeof f).passed, true);
  assert.deepEqual(Object.keys(f).sort(), ["apiState", "evidence"]);
});
it("does not modify observations or expose opaque run content", () => {
  const f = fixture(); notification(f).nativeSessionId = "PRIVATE_SESSION";
  notification(f).hiddenReasoning = "PRIVATE_REASONING"; notification(f).credential = "PRIVATE_CREDENTIAL";
  const before = JSON.stringify(f), result = gradeHiringTemplateTurns(f);
  assert.equal(JSON.stringify(f), before);
  assert.equal(result.version, HIRING_TEMPLATE_TURN_ACCOUNTING_VERSION);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|"company"|"board"|"account"|"notify-1"|"lead-first"/);
});

const missingObservations = [
  "evidence.agents", "evidence.tasks", "evidence.runs", "evidence.first", "evidence.second", "evidence.binding", "evidence.connectionId",
  "apiState.issue", "apiState.runs", "apiState.comments", "apiState.issue.companyId", "apiState.issue.conversationUserId",
  "apiState.issue.conversationAgentId", "apiState.issue.conversationSessionGeneration",
  "evidence.runs.0.identityHistory", "evidence.runs.0.contextSnapshot.aiConnection", "evidence.runs.0.startedAt", "evidence.runs.0.finishedAt",
  "evidence.tasks.0.completedAt", "evidence.tasks.0.originRunId", "apiState.comments.0.createdAt", "apiState.comments.3.createdByRunId",
];
for (const path of missingObservations) it(`fails closed without ${path}`, () => {
  const f = fixture(), keys = path.split(".");
  let target = f as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
  delete target[keys.at(-1)!];
  fails(f);
});
for (const [label, value] of [["null", null], ["undefined", undefined], ["string", "bad"], ["number", 42], ["boolean", true], ["array", []]] as const) {
  it(`rejects ${label} evidence without throwing`, () => fails({ evidence: value, apiState: fixture().apiState }));
  it(`rejects ${label} API state without throwing`, () => fails({ evidence: fixture().evidence, apiState: value }));
}
it("fails closed on unstringifiable accounting fields", () => {
  for (const value of [1n, Object.assign({}, { nested: {} })]) {
    const f = fixture();
    if (typeof value === "object") value.nested = value;
    notification(f).contextSnapshot = { ...notification(f).contextSnapshot, chatCompletionUpdates: value } as unknown as FixtureContext;
    fails(sync(f), "complete-public-run-ledger");
  }
});
it("retains the observed public cost count when evidence getters throw", () => {
  const f = fixture();
  const evidence = new Proxy(f.evidence, { get() { throw new Error("Malformed observation"); } });
  const result = gradeHiringTemplateTurns({ evidence, apiState: f.apiState });
  assert.equal(result.passed, false);
  assert.equal(result.counts.costAccountingRunCount, 7);
});

it("rejects a notification write_document despite valid tasks and replies", () => {
  const f = fixture();
  for (const event of f.evidence.readRuns[0]!.events) {
    const payload = event.payload.prpEvent.payload as Record<string, any>;
    if (payload.name) payload.name = "write_document";
    if (payload.item?.name) payload.item.name = "write_document";
  }
  fails(f, "completion-turns-only-report-actions");
  assert.equal(gradeHiringTemplateTurns(f).actionEvidence.status, "violated");
});
it("rejects a generic call_api document PUT even though it completes successfully", () => {
  const f = fixture();
  for (const event of f.evidence.readRuns[0]!.events) {
    const item = (event.payload.prpEvent.payload as Record<string, any>).item;
    if (item?.input) item.input.operationId = "PUT /api/issues/{id}/documents/{key}";
    if (item?.result) item.result.apiOperationId = "PUT /api/issues/{id}/documents/{key}";
  }
  fails(f, "completion-turns-only-report-actions");
  assert.equal(gradeHiringTemplateTurns(f).actionEvidence.status, "violated");
});
for (const defect of ["missing-stream", "missing-terminal", "missing-start", "unmatched-result", "separate-namespace",
  "api-error", "different-operation", "unknown-tool", "duplicate-result", "sequence-gap"] as const) {
  it(`does not certify notification action evidence with ${defect}`, () => {
    const f = fixture(), ledger = f.evidence.readRuns[0]!, events = ledger.events;
    const start = events[1]!.payload.prpEvent.payload as Record<string, any>;
    const result = events[2]!.payload.prpEvent.payload as Record<string, any>;
    if (defect === "missing-stream") f.evidence.readRuns = [];
    if (defect === "missing-terminal") ledger.events = events.slice(0, -1);
    if (defect === "missing-start") ledger.events = events.filter(e => e.eventType !== "item.started");
    if (defect === "unmatched-result") result.item.tool_use_id = "other";
    if (defect === "separate-namespace") { start.item.id = result.item.id = result.item.tool_use_id = "host-request"; }
    if (defect === "api-error") result.item.result.ok = false;
    if (defect === "different-operation") result.item.result.apiOperationId = "GET /api/issues/{id}";
    if (defect === "unknown-tool") (events[0]!.payload.prpEvent.payload as Record<string, any>).name = "unknown";
    if (defect === "duplicate-result") { ledger.events.splice(3, 0, structuredClone(events[2]!)); ledger.events.forEach((e, i) => e.seq = i + 1); }
    if (defect === "sequence-gap") events[2]!.seq++;
    fails(f, "completion-turns-only-report-actions");
  });
}
it("allows successful native readonly reads without claiming source identity", () => {
  const f = fixture();
  for (const ledger of f.evidence.readRuns) ledger.events = ledger.events.filter(event => !event.eventType.startsWith("item."))
    .map((event, i) => { const payload = event.payload.prpEvent.payload as Record<string, any>;
      if (payload.name) Object.assign(payload, { name: "Read File", operation: "read", readOnly: true, transport: "builtin" });
      return { ...event, seq: i + 1 }; });
  assert.equal(gradeHiringTemplateTurns(f).passed, true);
});

for (const [label, value] of [["non-2xx API result", { status: 500 }], ["explicit API error", { error: "failed" }],
  ["API is_error flag", { is_error: true }], ["API isError flag", { isError: true }]] as const) {
  it(`rejects ${label}`, () => {
    const f = fixture();
    Object.assign((f.evidence.readRuns[0]!.events[2]!.payload.prpEvent.payload as Record<string, any>).item.result, value);
    fails(f, "completion-turns-only-report-actions");
  });
}
it("does not trust a readonly hint on an unattributed call_api", () => {
  const f = fixture(), ledger = f.evidence.readRuns[0]!;
  ledger.events = ledger.events.filter(event => !event.eventType.startsWith("item."));
  ledger.events.forEach((event, i) => {
    event.seq = i + 1;
    const payload = event.payload.prpEvent.payload as Record<string, any>;
    if (payload.name) Object.assign(payload, { operation: "read", readOnly: true });
  });
  fails(f, "completion-turns-only-report-actions");
});
for (const [transport, operation, readOnly] of [["dynamic", "unknown", null], ["mcp", "execute", false]] as const) {
  it(`rejects ${transport} write_document with its actual production ${operation} shape`, () => {
    const f = fixture();
    for (const event of f.evidence.readRuns[0]!.events) {
      const payload = event.payload.prpEvent.payload as Record<string, any>;
      if (payload.name) Object.assign(payload, { name: "write_document", transport, operation, readOnly });
      if (payload.item?.name) payload.item.name = "write_document";
    }
    fails(f, "completion-turns-only-report-actions");
    assert.equal(gradeHiringTemplateTurns(f).actionEvidence.status, "violated");
  });
}
it("rejects an attempted mutation even if it fails and a benign read follows", () => {
  const f = fixture(), ledger = f.evidence.readRuns[0]!;
  const mutation = structuredClone(ledger.events.slice(0, 4));
  for (const event of mutation) {
    const payload = event.payload.prpEvent.payload as Record<string, any>;
    if (payload.executionId) payload.executionId = "mutation";
    if (payload.item) { payload.item.id = "mutation"; if (payload.item.tool_use_id) payload.item.tool_use_id = "mutation"; }
    if (payload.item?.input) payload.item.input.operationId = "POST /api/companies/{companyId}/issues";
    if (payload.item?.result) Object.assign(payload.item.result, { apiOperationId: "POST /api/companies/{companyId}/issues", ok: false, status: 403 });
  }
  ledger.events.unshift(...mutation);
  ledger.events.forEach((event, i) => event.seq = i + 1);
  fails(f, "completion-turns-only-report-actions");
  assert.equal(gradeHiringTemplateTurns(f).actionEvidence.status, "violated");
});
it("requires an accepted disposition and succeeded terminal in the action stream", () => {
  for (const defect of ["accepted", "terminal"] as const) {
    const f = fixture(), events = f.evidence.readRuns[0]!.events;
    const payload = events[defect === "accepted" ? 4 : 5]!.payload.prpEvent.payload as Record<string, any>;
    if (defect === "accepted") payload.result.schema = "wrong";
    else payload.runTerminalState = "failed";
    fails(f, "completion-turns-only-report-actions");
  }
});

it("admits a correlated native finish without forcing Done versus yielded chat disposition", () => {
  for (const disposition of ["done", "yielded"]) {
    const f = fixture(), ledger = f.evidence.readRuns[0]!;
    const start = structuredClone(ledger.events[0]!), finish = structuredClone(ledger.events[3]!);
    for (const event of [start, finish]) Object.assign(event.payload.prpEvent.payload,
      { executionId: "finish", name: "paperclip_finish", transport: "dynamic" });
    const proposal = { seq: 0, eventType: "run.result.proposed", payload: { prpEvent: {
      schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", itemId: "finish",
      payload: { schema: "paperclip.run_result.v1", reportedWorkDisposition: disposition },
    } } };
    ledger.events.splice(4, 0, start, proposal as unknown as typeof start, finish);
    ledger.events.forEach((event, i) => event.seq = i + 1);
    assert.equal(gradeHiringTemplateTurns(f).passed, true);
    (proposal.payload.prpEvent as Record<string, unknown>).itemId = "unrelated";
    fails(f, "completion-turns-only-report-actions");
  }
});
