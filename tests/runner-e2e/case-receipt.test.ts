import { describe, expect, it } from "vitest";
import { caseReceiptAgentPrompt, caseReceiptDefinitionDigest, caseReceiptTask } from "./case-receipt-cases.js";
import { gradeCaseReceipt, hasCaseDocumentRead, hasTaskDocumentRead, type CaseReceiptObservation } from "./case-receipt-scoring.js";
import { nativeSha256 } from "../../server/src/services/native-runtime/canonical.js";
import { redactRunnerApiPayloads } from "../../server/src/services/native-runtime/runner-api-log-redaction.js";
import { REDACTED_EVENT_VALUE } from "../../server/src/redaction.js";

const at = (milliseconds: number) => new Date(Date.parse("2026-10-19T00:00:00.000Z") + milliseconds).toISOString();
function valid(): CaseReceiptObservation {
  const agents = { triage: "triage", implementation: "builder", verification: "verifier" };
  const targets = [agents.triage, agents.implementation, agents.verification, agents.implementation];
  const phases = ["triage", "implementation", "verification", "revision"];
  const issue = { id: "task", companyId: "company", status: "done", assigneeAgentId: agents.implementation };
  const caseRecord = { id: "case", companyId: "company", workIssueId: "task", status: "done", phase: "done", handoffVersion: 5, completedAt: at(4600),
    pendingHandoff: null, fields: { nonce: "fixture", items: [{ quantity: 2, unitPrice: 3 }], currency: "USD", inputsValidated: true } };
  const runs = targets.map((agentId, index) => ({ id: `run-${index}`, agentId, companyId: "company", nativeIssueId: "task",
    runtimeMode: "native", status: "succeeded", startedAt: at(1000 + index * 1000), finishedAt: at(1700 + index * 1000),
    contextSnapshot: { paperclipCase: { id: "case", taskId: "task", phase: phases[index], handoffVersion: index + 1,
      issueStatusVersion: index * 2 + 1, incomingHandoff: { id: `handoff-${index}`, instructions: `fixture: ${phases[index]}` } } },
  }));
  const first = { id: "receipt-1", revisionNumber: 1, body: JSON.stringify({ total: 6 }), createdByAgentId: agents.implementation,
    createdByRunId: "run-1", createdAt: at(2200) };
  const last = { id: "receipt-2", revisionNumber: 2, body: JSON.stringify({ total: 6, currency: "USD" }), createdByAgentId: agents.implementation,
    createdByRunId: "run-3", createdAt: at(4200) };
  const review = { id: "review", companyId: "company", latestRevisionId: "review-1", latestRevisionNumber: 1,
    createdByAgentId: agents.verification, updatedByAgentId: agents.verification, body: JSON.stringify({ totalCorrect: true, missing: ["currency"] }),
    revision: { id: "review-1", revisionNumber: 1, body: JSON.stringify({ totalCorrect: true, missing: ["currency"] }),
      createdByAgentId: agents.verification, createdByRunId: "run-2", createdAt: at(3200) } };
  return {
    nonce: "fixture", companyId: "company", taskId: "task", caseId: "case", agents, issue, caseRecord, tasks: [issue],
    cases: [caseRecord, ...["draft", "done"].map((status, index) => ({ id: `passive-${index}`, companyId: "company", caseType: "receipt-research",
      workIssueId: null, phase: null, handoffVersion: 0, status, fields: { nonce: "fixture" } }))],
    handoffs: [...phases.map((phase, index) => ({ id: `handoff-${index}`, companyId: "company", caseId: "case", issueId: "task", phase, destinationKind: "agent",
      version: index + 1, state: "delivered", fromAgentId: targets[index - 1] ?? targets[0], toAgentId: targets[index],
      sourceRunId: index ? `run-${index - 1}` : null, appliedIssueStatusVersion: index * 2,
      assignmentAppliedAt: at(index ? 750 + index * 1000 : 900), deliveredAt: at(1000 + index * 1000) })),
      { id: "handoff-done", companyId: "company", caseId: "case", issueId: "task", phase: "done", destinationKind: "done",
        version: 5, state: "completed", fromAgentId: agents.implementation, toAgentId: null, sourceRunId: "run-3", completedAt: at(4600) }],
    runs, receipt: { id: "receipt", companyId: "company", latestRevisionId: "receipt-2", latestRevisionNumber: 2,
      createdByAgentId: agents.implementation, updatedByAgentId: agents.implementation, body: last.body },
    receiptRevisions: [last, first], review,
    handoffToolRunIds: ["run-0", "run-1", "run-2", "run-3"], verifierReadReceipt: true, builderReadReview: true, kickoffReplayed: true, pendingInteractions: 0, initialBrief: { issueId:"task", key:"brief", latestRevisionNumber:1, latestBody:"Receipt fixture: total and currency are required." }, triageReadBrief: true,
    budgets: { company: { budgetMonthlyCents: 100 }, agents: Object.values(agents).map(id => ({ id, budgetMonthlyCents: 100 })) },
    configuredLimits: { maxRuns: 4, runTimeoutMs: 90_000, attemptTimeoutMs: 300_000, automaticRetryPolicy: "single_attempt",
      agents: Object.values(agents).map((id, index) => ({ id, maxDailyRuns: [1, 2, 1][index], maxConcurrentRuns: 1,
        heartbeatEnabled: false, timeoutSec: 90, modelReasoningEffort: "low" })) },
  };
}

describe("receipt smoke fixture", () => {
  it("bounds the workflow without putting its graph into the task objective", () => {
    expect(caseReceiptTask).toMatchObject({ id: "receipt-smoke", flow: "case_handoff", expectedRunCount: 4, minimumExpectedRunCount: 4,
      automaticRetryPolicy: "single_attempt", turnTimeoutMs: 90_000, attemptTimeoutMs: { local: 300_000, daytona: 300_000 } });
    expect(caseReceiptTask.buildPrompt("fixture")).not.toMatch(/triage|handoff_case|verification/);
    const agents = valid().agents;
    for (const role of ["triage", "implementation", "verification"] as const) {
      const prompt = caseReceiptAgentPrompt(role, agents, "fixture");
      expect(prompt.length).toBeLessThan(4000);
      expect(prompt).toContain("read_document");
      expect(prompt).not.toContain("read_case_document");
      expect(prompt).toContain("write_document");
      expect(prompt).not.toContain("write_case_document");
      expect(prompt).toContain("read_case");
      expect(prompt).toContain("baseRevisionId");
      expect(prompt).toContain("handoff_case");
      expect(prompt).toContain("No shell");
    }
    expect(caseReceiptAgentPrompt("triage", agents, "fixture")).not.toContain("Intentionally omit");
    expect(caseReceiptAgentPrompt("implementation", agents, "fixture")).toContain("Intentionally omit currency");
    expect(caseReceiptAgentPrompt("verification", agents, "fixture")).toContain("Never infer the saved receipt from handoff prose");
    expect(caseReceiptDefinitionDigest()).toMatch(/^[a-f0-9]{64}$/);
  });
  it("accepts public persisted evidence, including newest-first revision lists", () => {
    const checks = gradeCaseReceipt(valid());
    expect(checks.length).toBeGreaterThan(8);
    expect(checks.filter(check => !check.passed)).toEqual([]);
  });
  const mutations: Array<[string, (observation: CaseReceiptObservation) => void]> = [
    ["missing initial task brief", o => { o.initialBrief = null; }],
    ["wrong brief owner", o => { o.initialBrief!.issueId = "other-task"; }],
    ["triage never read the initial brief", o => { o.triageReadBrief = false; }],
    ["wrong receipt arithmetic", o => { o.receipt!.body = JSON.stringify({ total: 5, currency: "USD" }); }],
    ["missing final currency", o => { o.receipt!.body = JSON.stringify({ total: 6 }); }],
    ["the builder skips the deliberate first omission", o => { o.receiptRevisions[1]!.body = JSON.stringify({ total: 6, currency: "USD" }); }],
    ["no persisted first receipt", o => { o.receiptRevisions.pop(); }],
    ["receipt history attributed to the wrong run", o => { o.receiptRevisions[0]!.createdByRunId = "run-1"; }],
    ["a verifier rewrites the receipt", o => { o.receiptRevisions[0]!.createdByAgentId = o.agents.verification; }],
    ["a stale current receipt revision", o => { o.receipt!.latestRevisionId = "receipt-1"; }],
    ["a guessed passing review", o => { o.review!.body = JSON.stringify({ totalCorrect: true, missing: [] }); }],
    ["review prose with no actual revision", o => { delete o.review!.revision; }],
    ["review written by the builder", o => { o.review!.revision.createdByAgentId = o.agents.implementation; }],
    ["a review attributed to an unrelated run", o => { o.review!.revision.createdByRunId = "other-run"; }],
    ["review after the correction", o => { o.review!.revision.createdAt = at(4500); }],
    ["verifier never reads persisted receipt", o => { o.verifierReadReceipt = false; }],
    ["returning builder never reads persisted review", o => { o.builderReadReview = false; }],
    ["changed input data", o => { o.caseRecord.fields.items[0].quantity = 3; }],
    ["missing persisted triage validation", o => { delete o.caseRecord.fields.inputsValidated; }],
    ["a new task per phase", o => { o.tasks.push({ id: "extra", status: "todo" }); }],
    ["primary task replaced", o => { o.caseRecord.workIssueId = "replacement"; }],
    ["a passive case starts work", o => { o.cases[1]!.workIssueId = "task"; }],
    ["an extra workflow case", o => { o.cases.push({ id: "extra-case", workIssueId: "other-task" }); }],
    ["a handoff changes task", o => { o.handoffs[2]!.issueId = "other-task"; }],
    ["a missing phase handoff", o => { o.handoffs.pop(); }],
    ["mismatched source provenance", o => { o.handoffs[2]!.sourceRunId = "run-0"; }],
    ["transfer applies before source stops", o => { o.handoffs[2]!.assignmentAppliedAt = at(2500); }],
    ["missing native transfer receipts", o => { o.handoffToolRunIds = []; }],
    ["lost kickoff replay", o => { o.kickoffReplayed = false; }],
    ["one extra run", o => { o.runs.push({ ...o.runs[3]!, id: "extra" }); }],
    ["a different final worker", o => { o.runs[3]!.agentId = o.agents.triage; }],
    ["overlapping provider runs", o => { o.runs[2]!.startedAt = at(2500); }],
    ["unsettled run", o => { o.runs[3]!.status = "running"; }],
    ["missing timing evidence", o => { delete o.runs[1]!.finishedAt; }],
    ["stale returning-agent context", o => { o.runs[3]!.contextSnapshot.paperclipCase.handoffVersion = 2; }],
    ["wrong incoming handoff", o => { o.runs[3]!.contextSnapshot.paperclipCase.incomingHandoff.id = "handoff-1"; }],
    ["no admitted case context", o => { delete o.runs[0]!.contextSnapshot.paperclipCase; }],
    ["case left open after explicit completion", o => { o.caseRecord.status = "draft"; }],
    ["terminal handoff never completed", o => { o.handoffs[4]!.state = "awaiting_completion"; }],
    ["terminal handoff attributed to another run", o => { o.handoffs[4]!.sourceRunId = "run-2"; }],
    ["case closes before final work begins", o => { o.caseRecord.completedAt = o.handoffs[4]!.completedAt = at(2500); }],
    ["no terminal native tool receipt", o => { o.handoffToolRunIds.pop(); }],
    ["a pending approval", o => { o.pendingInteractions = 1; }],
    ["no configured-limit readback", o => { delete o.configuredLimits; }],
    ["no actual budget readback", o => { delete o.budgets; }],
    ["an unlimited returning builder", o => { o.configuredLimits!.agents[1]!.maxDailyRuns = 0; }],
    ["automatic retries", o => { o.configuredLimits!.automaticRetryPolicy = "retry"; }],
  ];
  it.each(mutations)("rejects %s", (_name, mutate) => {
    const observation = valid(); mutate(observation);
    expect(gradeCaseReceipt(observation).some(check => !check.passed)).toBe(true);
  });
});

describe("persisted case document read evidence", () => {
  const operation = "GET /api/cases/{id}/documents/{key}";
  const event = (seq: number, eventType: string, payload: Record<string, any>) => ({ seq, eventType, protocolSchemaVersion: 2,
    payload: { prpEvent: { schema: "paperclip.prp.event.v2", schemaVersion: 2, sourceKind: "runner", payload } } });
  function read() {
    return [event(1, "item.started", { item: { type: "tool_use", name: "call_api", id: "read", input: { operationId: operation, pathParams: { id: "case", key: "receipt" } } } }),
      event(2, "item.completed", { item: { type: "tool_result", id: "read", tool_use_id: "read", result: { ok: true, status: 200, apiOperationId: operation,
        data: { id: "receipt", key: "receipt", latestRevisionId: "receipt-1", body: '{"total":6}' } } } }),
      event(3, "tool.execution.completed", { name: "call_api", executionId: "read", status: "completed" })];
  }
  it("requires a real successful GET with saved document and revision metadata", () => {
    expect(hasCaseDocumentRead(read(), "case", "receipt")).toBe(true);
    expect(hasCaseDocumentRead(read(), "different-case", "receipt")).toBe(false);
    expect(hasCaseDocumentRead(read(), "case", "review")).toBe(false);
    expect(hasCaseDocumentRead([], "case", "receipt")).toBe(false);
    expect(hasCaseDocumentRead([event(1, "item.completed", { kind: "agentMessage", text: "I read receipt" })], "case", "receipt")).toBe(false);
    const reversed = read(); reversed[1]!.seq = 4; reversed[2]!.seq = 3;
    expect(hasCaseDocumentRead(reversed, "case", "receipt")).toBe(true);
  });
  const corruptions: Array<[string, (events: any[]) => void]> = [
    ["missing call input", events => { events.shift(); }],
    ["missing tool completion", events => { events.pop(); }],
    ["a failed API response", events => { events[1].payload.prpEvent.payload.item.result.ok = false; }],
    ["a refused API status", events => { events[1].payload.prpEvent.payload.item.result.status = 403; }],
    ["a failed execution", events => { events[2].payload.prpEvent.payload.status = "failed"; }],
    ["an unrelated execution ID", events => { events[2].payload.prpEvent.payload.executionId = "other"; }],
    ["an unrelated result ID", events => { events[1].payload.prpEvent.payload.item.id = "other"; }],
    ["an unrelated tool-use ID", events => { events[1].payload.prpEvent.payload.item.tool_use_id = "other"; }],
    ["a task document read", events => { events[0].payload.prpEvent.payload.item.input.operationId = "GET /api/issues/{id}/documents/{key}"; }],
    ["a write with document-looking result", events => { events[0].payload.prpEvent.payload.item.input.operationId = "PUT /api/cases/{id}/documents/{key}"; }],
    ["a different returned operation", events => { events[1].payload.prpEvent.payload.item.result.apiOperationId = "GET /api/agents/me"; }],
    ["a different returned document", events => { events[1].payload.prpEvent.payload.item.result.data.key = "review"; }],
    ["a result without persisted revision", events => { delete events[1].payload.prpEvent.payload.item.result.data.latestRevisionId; }],
    ["a result without returned body", events => { delete events[1].payload.prpEvent.payload.item.result.data.body; }],
    ["provider-authored receipt lookalikes", events => { events.forEach(row => { row.payload.prpEvent.sourceKind = "provider"; }); }],
    ["a mismatched protocol version", events => { events[1].protocolSchemaVersion = 3; }],
    ["a completion before its call", events => { events[2].seq = 0; }],
  ];
  it.each(corruptions)("rejects %s", (_name, corrupt) => {
    const events = read(); corrupt(events);
    expect(hasCaseDocumentRead(events, "case", "receipt")).toBe(false);
  });

  it("proves the exact read using the production persistence redaction contract", () => {
    const events = redactRunnerApiPayloads(read());
    const input = events[0]!.payload.prpEvent.payload.item.input;
    const result = events[1]!.payload.prpEvent.payload.item.result;
    expect(input.pathParams).toBeUndefined();
    expect(input).toMatchObject({ operationId: operation, data: REDACTED_EVENT_VALUE, apiPayloadRedacted: true,
      apiPayloadSha256: nativeSha256({ operationId: operation, pathParams: { id: "case", key: "receipt" } }) });
    expect(result.data).toBe(REDACTED_EVENT_VALUE);
    expect(hasCaseDocumentRead(events, "case", "receipt")).toBe(true);
    expect(hasCaseDocumentRead(redactRunnerApiPayloads(events), "case", "receipt")).toBe(true);
    expect(hasCaseDocumentRead(events, "other-case", "receipt")).toBe(false);
    expect(hasCaseDocumentRead(events, "case", "review")).toBe(false);
  });

  it("accepts canonical property ordering and the explicitly supported empty query", () => {
    const events = read();
    events[0]!.payload.prpEvent.payload.item.input = { query: {}, pathParams: { key: "receipt", id: "case" }, operationId: operation };
    expect(hasCaseDocumentRead(redactRunnerApiPayloads(events), "case", "receipt")).toBe(true);
  });

  const redactedCorruptions: Array<[string, (events: any[]) => void]> = [
    ["missing request digest", events => { delete events[0].payload.prpEvent.payload.item.input.apiPayloadSha256; }],
    ["incorrect request digest", events => { events[0].payload.prpEvent.payload.item.input.apiPayloadSha256 = "a".repeat(64); }],
    ["missing request redaction marker", events => { delete events[0].payload.prpEvent.payload.item.input.apiPayloadRedacted; }],
    ["unredacted request data", events => { events[0].payload.prpEvent.payload.item.input.data = {}; }],
    ["reintroduced request parameters", events => { events[0].payload.prpEvent.payload.item.input.pathParams = { id: "case", key: "receipt" }; }],
    ["missing response digest", events => { delete events[1].payload.prpEvent.payload.item.result.apiPayloadSha256; }],
    ["malformed response digest", events => { events[1].payload.prpEvent.payload.item.result.apiPayloadSha256 = "invalid"; }],
    ["missing response redaction marker", events => { delete events[1].payload.prpEvent.payload.item.result.apiPayloadRedacted; }],
    ["unredacted response data", events => { events[1].payload.prpEvent.payload.item.result.data = { id: "receipt", key: "receipt", latestRevisionId: "receipt-1", body: "{}" }; }],
    ["unsuccessful redacted response", events => { events[1].payload.prpEvent.payload.item.result.ok = false; }],
    ["refused redacted response", events => { events[1].payload.prpEvent.payload.item.result.status = 404; }],
    ["mismatched redacted operation", events => { events[1].payload.prpEvent.payload.item.result.apiOperationId = "GET /api/agents/me"; }],
    ["unrelated redacted result", events => { events[1].payload.prpEvent.payload.item.id = "other-call"; }],
    ["unrelated redacted execution", events => { events[2].payload.prpEvent.payload.executionId = "other-call"; }],
    ["missing redacted execution completion", events => { events.pop(); }],
    ["a failed redacted execution", events => { events[2].payload.prpEvent.payload.status = "failed"; }],
    ["a provider-authored redacted lookalike", events => { events.forEach(row => { row.payload.prpEvent.sourceKind = "provider"; }); }],
  ];
  it.each(redactedCorruptions)("rejects %s", (_name, corrupt) => {
    const events = redactRunnerApiPayloads(read()); corrupt(events);
    expect(hasCaseDocumentRead(events, "case", "receipt")).toBe(false);
  });

  it.each([
    { operationId: operation, pathParams: { id: "other-case", key: "receipt" } },
    { operationId: operation, pathParams: { id: "case", key: "review" } },
    { operationId: "PUT /api/cases/{id}/documents/{key}", pathParams: { id: "case", key: "receipt" } },
    { operationId: operation, pathParams: { id: "case", key: "receipt" }, query: { unknown: "value" } },
  ])("rejects a production-redacted request for different inputs %j", input => {
    const events = read(); events[0]!.payload.prpEvent.payload.item.input = input;
    expect(hasCaseDocumentRead(redactRunnerApiPayloads(events), "case", "receipt")).toBe(false);
  });

  function readThenWrite() {
    const writeOperation = "PUT /api/cases/{id}/documents/{key}";
    return [...read(),
      event(4, "item.started", { item: { type: "tool_use", name: "call_api", id: "write", input: {
        operationId: writeOperation, pathParams: { id: "case", key: "review" },
        body: { format: "markdown", body: '{"totalCorrect":true,"missing":["currency"]}' },
      } } }),
      event(5, "item.completed", { item: { type: "tool_result", id: "write", tool_use_id: "write", result: {
        ok: true, status: 200, apiOperationId: writeOperation,
        data: { document: { id: "review" }, revision: { id: "review-1" } },
      } } }),
      event(6, "tool.execution.completed", { name: "call_api", executionId: "write", status: "completed" }),
    ];
  }

  function nativeReadThenWrite() {
    return readThenWrite().map(row => {
      const payload = row.payload.prpEvent.payload;
      const item = payload.item;
      if (item?.type === "tool_use") {
        const write = item.input.operationId.startsWith("PUT");
        const { pathParams, body } = item.input;
        item.name = write ? "write_case_document" : "read_case_document";
        item.input = { caseId: pathParams.id, key: pathParams.key,
          ...(write ? { idempotencyKey: "review-first", title: "Review", body: body.body } : {}) };
      }
      if (row.eventType === "tool.execution.completed") {
        payload.name = payload.executionId === "read" ? "read_case_document" : "write_case_document";
      }
      return row;
    });
  }

  it.each([false, true])("accepts native case document reads before writes (production redaction: %s)", persist => {
    const events = nativeReadThenWrite();
    const saved = persist ? redactRunnerApiPayloads(events) : events;
    expect(hasCaseDocumentRead(saved, "case", "receipt", true)).toBe(true);
    expect(hasCaseDocumentRead(saved, "other-case", "receipt", true)).toBe(false);
    expect(hasCaseDocumentRead(saved, "case", "review", true)).toBe(false);
  });

  it.each([false, true])("rejects incomplete or misattributed native case read evidence (production redaction: %s)", persist => {
    const mutations = [
      (events: any[]) => { events[0].payload.prpEvent.payload.item.input.caseId = "other-case"; },
      (events: any[]) => { events[0].payload.prpEvent.payload.item.input.key = "other-document"; },
      (events: any[]) => { events[1].payload.prpEvent.payload.item.result.ok = false; },
      (events: any[]) => { events[2].payload.prpEvent.payload.name = "call_api"; },
      (events: any[]) => { events[3].seq = 0; },
      (events: any[]) => { events[4].payload.prpEvent.payload.item.result.status = 409; },
      (events: any[]) => { events.forEach(row => { row.payload.prpEvent.sourceKind = "provider"; }); },
    ];
    for (const mutate of mutations) {
      const events = nativeReadThenWrite();
      mutate(events);
      expect(hasCaseDocumentRead(persist ? redactRunnerApiPayloads(events) : events, "case", "receipt", true)).toBe(false);
    }
  });

  it.each([false, true])("can require successful read-before-write evidence (production redaction: %s)", persist => {
    const events = persist ? redactRunnerApiPayloads(readThenWrite()) : readThenWrite();
    expect(hasCaseDocumentRead(events, "case", "receipt", true)).toBe(true);
    expect(hasCaseDocumentRead(read(), "case", "receipt")).toBe(true);
    expect(hasCaseDocumentRead(read(), "case", "receipt", true)).toBe(false);
  });

  const writeCorruptions: Array<[string, (events: any[]) => void]> = [
    ["write started before the read", events => { events[3].seq = 0; }],
    ["write started before the read returned", events => { events[3].seq = 1; }],
    ["read result arrived after write start", events => { events[1].seq = 7; }],
    ["missing case-document write", events => { events.splice(3); }],
    ["missing write result", events => { events.splice(4, 1); }],
    ["missing write completion", events => { events.pop(); }],
    ["failed write execution", events => { events[5].payload.prpEvent.payload.status = "failed"; }],
    ["failed write response", events => { events[4].payload.prpEvent.payload.item.result.ok = false; }],
    ["refused write status", events => { events[4].payload.prpEvent.payload.item.result.status = 409; }],
    ["unrelated write response operation", events => { events[4].payload.prpEvent.payload.item.result.apiOperationId = operation; }],
    ["unrelated write result ID", events => { events[4].payload.prpEvent.payload.item.id = "unrelated"; }],
    ["unrelated write tool-use ID", events => { events[4].payload.prpEvent.payload.item.tool_use_id = "unrelated"; }],
    ["unrelated write completion", events => { events[5].payload.prpEvent.payload.executionId = "unrelated"; }],
    ["write completed before it started", events => { events[5].seq = 0; }],
    ["provider-authored write lookalike", events => { for (const row of events.slice(3)) row.payload.prpEvent.sourceKind = "provider"; }],
  ];
  describe.each([false, true])("read-before-write evidence (production redaction: %s)", persist => {
    it.each(writeCorruptions)("rejects %s", (_name, corrupt) => {
      const events = readThenWrite(); corrupt(events);
      expect(hasCaseDocumentRead(persist ? redactRunnerApiPayloads(events) : events, "case", "receipt", true)).toBe(false);
    });
  });

  it("does not skip an unsuccessful first write in favor of a later successful one", () => {
    const events = readThenWrite();
    const later = structuredClone(events.slice(3));
    later.forEach(row => {
      row.seq += 3;
      const payload = row.payload.prpEvent.payload;
      if (payload.item) { payload.item.id = "later-write"; if (payload.item.tool_use_id) payload.item.tool_use_id = "later-write"; }
      if (payload.executionId) payload.executionId = "later-write";
    });
    events[4]!.payload.prpEvent.payload.item.result.ok = false;
    expect(hasCaseDocumentRead(redactRunnerApiPayloads([...events, ...later]), "case", "receipt", true)).toBe(false);
  });

  it.each([
    (events: any[]) => { delete events[4].payload.prpEvent.payload.item.result.apiPayloadSha256; },
    (events: any[]) => { delete events[3].payload.prpEvent.payload.item.input.apiPayloadSha256; },
    (events: any[]) => {
      delete events[3].payload.prpEvent.payload.item.input.apiPayloadSha256;
      delete events[3].payload.prpEvent.payload.item.input.apiPayloadRedacted;
    },
    (events: any[]) => {
      delete events[4].payload.prpEvent.payload.item.result.apiPayloadSha256;
      delete events[4].payload.prpEvent.payload.item.result.apiPayloadRedacted;
    },
  ])("rejects inconsistent production-redacted write receipts %s", corrupt => {
    const events = redactRunnerApiPayloads(readThenWrite());
    corrupt(events);
    expect(hasCaseDocumentRead(events, "case", "receipt", true)).toBe(false);
  });
});

describe("ordinary task document read evidence", () => {
  const event = (seq: number, eventType: string, payload: Record<string, any>) => ({ seq, eventType, protocolSchemaVersion: 2,
    payload: { prpEvent: { schema: "paperclip.prp.event.v2", schemaVersion: 2, sourceKind: "runner", payload } } });
  const document = (key: string) => ({ id: `${key}-id`, issueId: "task", key, latestRevisionId: `${key}-revision`,
    latestRevisionNumber: 1, latestBody: "{}" });
  function evidence() {
    return [
      event(1, "item.started", { item: { type: "tool_use", id: "read", name: "read_document", input: { key: "receipt" } } }),
      event(2, "item.completed", { item: { type: "tool_result", id: "read", tool_use_id: "read", result: { document: document("receipt") } } }),
      event(3, "tool.execution.completed", { name: "read_document", executionId: "read", status: "completed" }),
      event(4, "item.started", { item: { type: "tool_use", id: "write", name: "write_document", input: {
        key: "review", title: "Review", body: "{}", idempotencyKey: "review-one",
      } } }),
      event(5, "item.completed", { item: { type: "tool_result", id: "write", tool_use_id: "write", result: { document: document("review") } } }),
      event(6, "tool.execution.completed", { name: "write_document", executionId: "write", status: "completed" }),
    ];
  }
  it("requires a task-owned persisted read and a correlated successful write", () => {
    expect(hasTaskDocumentRead(evidence(), "task", "receipt", true)).toBe(true);
    expect(hasTaskDocumentRead(evidence().slice(0, 3), "task", "receipt")).toBe(true);
    expect(hasTaskDocumentRead(evidence().slice(0, 3), "task", "receipt", true)).toBe(false);
    expect(hasTaskDocumentRead(evidence(), "other-task", "receipt", true)).toBe(false);
    expect(hasTaskDocumentRead(evidence(), "task", "other-key", true)).toBe(false);
  });
  const corruptions: Array<[string, (events: any[]) => void]> = [
    ["read result belongs to another task", e => { e[1].payload.prpEvent.payload.item.result.document.issueId = "other-task"; }],
    ["write result belongs to another task", e => { e[4].payload.prpEvent.payload.item.result.document.issueId = "other-task"; }],
    ["unpersisted document", e => { delete e[1].payload.prpEvent.payload.item.result.document.latestRevisionId; }],
    ["missing returned body", e => { delete e[1].payload.prpEvent.payload.item.result.document.latestBody; }],
    ["wrong returned key", e => { e[1].payload.prpEvent.payload.item.result.document.key = "other-key"; }],
    ["wrong call key", e => { e[0].payload.prpEvent.payload.item.input.key = "other-key"; }],
    ["unrelated read result", e => { e[1].payload.prpEvent.payload.item.id = "other"; }],
    ["unrelated read execution", e => { e[2].payload.prpEvent.payload.executionId = "other"; }],
    ["read execution failed", e => { e[2].payload.prpEvent.payload.status = "failed"; }],
    ["write execution failed", e => { e[5].payload.prpEvent.payload.status = "failed"; }],
    ["missing successful write result", e => { e.splice(4, 1); }],
    ["write starts before read result", e => { e[3].seq = 1; }],
    ["read finishes after write starts", e => { e[2].seq = 5; }],
    ["provider-authored lookalikes", e => { e.forEach(row => { row.payload.prpEvent.sourceKind = "provider"; }); }],
    ["wrong envelope version", e => { e[1].protocolSchemaVersion = 3; }],
    ["retired case tool", e => { e[0].payload.prpEvent.payload.item.name = "read_case_document"; }],
  ];
  it.each(corruptions)("rejects %s", (_label, mutate) => {
    const rows = evidence(); mutate(rows);
    expect(hasTaskDocumentRead(rows, "task", "receipt", true)).toBe(false);
  });
});
