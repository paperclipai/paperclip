import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cardAccountingReady, cardChecklistInstructions, cardChecklistPurpose, cardUsageComplete, genuineCardChecklistSuccess, genuineCardWorkFailure } from "./status-card-work-failure.js";
import { notesReadResponse } from "./external-provider.js";
import { cardWorkFixture, successfulCardWorkFixture } from "./status-card-work-failure.test-fixtures.js";
const grade = (v: ReturnType<typeof cardWorkFixture>) => genuineCardWorkFailure(v.card, v.update, v.runId, "ceo", v.evidence);
describe("real required-input work failure, not a provider failure", () => {
  it("accepts the exact normally completed native work, authorized read error and blocked card-generation projection", () => expect(grade(cardWorkFixture())).toBe(true));
  it("rejects a card projection before the actual required read's completed tool receipt", () => {
    const v = cardWorkFixture(), invocation = v.evidence.decisions.decisions[0]!.invocation;
    for (const finishedAt of [v.evidence.runs.find(r => r.id === v.runId)!.startedAt!, new Date(v.evidence.calls[0]!.respondedAt!).toISOString(), new Date(new Date(invocation.completedAt!).getTime() - 1).toISOString()]) {
      v.update.finishedAt = finishedAt; expect(grade(v)).toBe(false);
    }
  });
  it("accepts exact same-millisecond causal completion for Date and serialized receipt fields", () => {
    for (const asDate of [false, true]) {
      const v = cardWorkFixture(), invocation = v.evidence.decisions.decisions[0]!.invocation;
      v.update.finishedAt = new Date(invocation.completedAt!).toISOString();
      if (asDate) { invocation.startedAt = new Date(invocation.startedAt!); invocation.completedAt = new Date(invocation.completedAt!); }
      expect(grade(v)).toBe(true);
    }
  });
  it("keeps the original causal failure when a separately bound later read also fails", () => {
    const v = cardWorkFixture(), first = v.evidence.decisions.decisions[0]!;
    const next = structuredClone(first); next.invocation.id = "later-invocation";
    next.invocation.startedAt = new Date("2026-10-28T12:00:26Z"); next.invocation.completedAt = new Date("2026-10-28T12:00:28Z");
    next.auditEvents[0]!.invocationId = next.invocation.id;
    ((next.auditEvents[0]!.metadata!.execution as {request:{requestId:string}}).request).requestId = "later-request";
    v.evidence.decisions.decisions.push(next);
    v.evidence.calls.push({ ...v.evidence.calls[0]!, sequence: 5, receivedAt: Date.parse("2026-10-28T12:00:26Z"), respondedAt: Date.parse("2026-10-28T12:00:27Z"), requestIdSha256: createHash("sha256").update("later-request").digest("hex") });
    expect(grade(v)).toBe(true);
    v.update.finishedAt = "2026-10-28T12:00:20Z"; expect(grade(v)).toBe(false);
  });
  for (const key of ["companyId", "agentId", "id"] as const) it(`rejects foreign actual run ${key}`, () => {
    const v = cardWorkFixture(); Object.assign(v.evidence.runs.find(r => r.id === v.runId)!, { [key]: "foreign" }); expect(grade(v)).toBe(false);
  });
  for (const status of ["failed", "cancelled", "timed_out", "running"]) it(`rejects provider status ${status}`, () => {
    const v = cardWorkFixture(); Object.assign(v.evidence.runs.find(r => r.id === v.runId)!, { status }); expect(grade(v)).toBe(false);
  });
  for (const key of ["companyId", "workerId", "connectionId", "readEntryId", "instructionRevisionId", "instructionSha256", "interestPrompt"] as const) it(`rejects wrong recipe ${key}`, () => {
    const v = cardWorkFixture(); v.evidence.recipe[key] = "foreign"; expect(grade(v)).toBe(false);
  });
  for (const key of ["id", "companyId", "assigneeAgentId", "status", "description"] as const) it(`rejects wrong generation ${key}`, () => {
    const v = cardWorkFixture(); v.evidence.generation[key] = "foreign"; expect(grade(v)).toBe(false);
  });
  for (const key of ["companyId", "statusCardId", "generationIssueId"]) it(`rejects foreign generation payload ${key}`, () => {
    const v = cardWorkFixture(); const p = { companyId: "company", statusCardId: "card", generationIssueId: "failure-task", [key]: "foreign" };
    v.evidence.generation.description = '```json\n'+JSON.stringify(p)+'\n```'; expect(grade(v)).toBe(false);
  });
  for (const key of ["cardId", "generationIssueId", "status", "error", "finishedAt"] as const) it(`rejects absent/wrong failed update ${key}`, () => {
    const v = cardWorkFixture(); Object.assign(v.update, { [key]: key === "error" || key === "finishedAt" ? null : "foreign" }); expect(grade(v)).toBe(false);
  });
  it("requires actual card error/cleared claim, independent of a blocked task", () => {
    for (const patch of [{ state: "active" }, { failureReason: null }, { generatingIssueId: "failure-task" }]) { const v = cardWorkFixture(); Object.assign(v.card, patch); expect(grade(v)).toBe(false); }
  });
  for (const patch of [{ authorized: false }, { responseHttpStatus: 403 }, { toolError: false }, { requestIdSha256: "foreign" }, { responseSha256: "foreign" }, { name: "launch_update" }, { receivedAt: 0 }, { respondedAt: Date.now() + 1e9 }]) it(`rejects wrong provider evidence ${Object.keys(patch)}`, () => {
    const v = cardWorkFixture(); Object.assign(v.evidence.calls[0]!, patch); expect(grade(v)).toBe(false);
  });
  it("rejects an unmatched additional read and reversed call chronology", () => {
    const v = cardWorkFixture(); v.evidence.calls.push({ ...v.evidence.calls[0]!, sequence: 5, requestIdSha256: "foreign" }); expect(grade(v)).toBe(false);
    v.evidence.calls.pop(); v.evidence.calls[0]!.respondedAt = v.evidence.calls[0]!.receivedAt! - 1; expect(grade(v)).toBe(false);
  });
  for (const patch of [{ policyDecision: "deny" }, { status: "succeeded" }, { errorCode: "permission_denied" }, { runId: "foreign" }, { connectionId: "foreign" }, { catalogEntryId: "foreign" }, { issueId: "foreign" }, { argumentsHash: null }]) it(`rejects wrong invocation ${Object.keys(patch)}`, () => {
    const v = cardWorkFixture(); Object.assign(v.evidence.decisions.decisions[0]!.invocation, patch); expect(grade(v)).toBe(false);
  });
  it("rejects fake dispatch/HTTP/error receipts, missing worker explanation and unrelated status changes", () => {
    const v = cardWorkFixture();
    for (const mutate of [(x: typeof v) => { x.evidence.decisions.decisions[0]!.auditEvents = []; },
      (x: typeof v) => { x.evidence.comments[0]!.createdByRunId = "foreign"; },
      (x: typeof v) => { x.evidence.comments[0]!.body = "Everything is fresh"; },
      (x: typeof v) => { x.evidence.activity[0]!.runId = "foreign"; },
      (x: typeof v) => { x.evidence.activity[0]!.details = { status: "blocked" }; }]) { const copy = structuredClone(v); mutate(copy); expect(grade(copy)).toBe(false); }
    const e = v.evidence.decisions.decisions[0]!.auditEvents[0]!.metadata!.execution as { request: { dispatched: boolean }; response: { httpStatus: number } };
    e.request.dispatched = false; expect(grade(v)).toBe(false); e.request.dispatched = true; e.response.httpStatus = 500; expect(grade(v)).toBe(false);
  });
});
describe("complete settled usage with explicit unpriced allow", () => {
  it("accepts complete unpriced receipts without inventing zero dollar cost", () => {
    const v = cardWorkFixture(); expect(cardUsageComplete(v.evidence.runs[0]!)).toBe(true); expect(grade(v)).toBe(true);
    expect(v.evidence.runs[0]!.usageJson).not.toHaveProperty("costUsd");
  });
  for (const patch of [{ costAccountingPending: true }, { costAccountedAt: null }, { finishedAt: null }]) it(`rejects incomplete settlement ${Object.keys(patch)}`, () => {
    const v = cardWorkFixture(); Object.assign(v.evidence.runs[0]!, patch); expect(grade(v)).toBe(false);
  });
  for (const patch of [{ accountingReceiptReady: false }, { accountingCaptureFailed: true }, { accountingProviderWorkStarted: false }, { accountingReceiptId: "" }, { accountingReceiptSourceId: "" }, { accountingReceiptSequence: 0 }, { usageSource: "aggregate" }, { inputTokens: 0, outputTokens: 0 }]) it(`rejects incomplete usage ${Object.keys(patch)}`, () => {
    const v = cardWorkFixture(); Object.assign(v.evidence.runs[0]!.usageJson!, patch); expect(grade(v)).toBe(false);
  });
  for (const patch of [{ unpricedUsagePolicy: "deny" }, { pendingRunCount: 1 }, { amount: 0 }, { isActive: false }, { paused: true }, { status: "hard_stop" }, { remainingAmount: 0 }]) it(`rejects policy/accounting boundary ${Object.keys(patch)}`, () => {
    const v = cardWorkFixture(); Object.assign(v.evidence.overview.policies[0]!, patch); expect(grade(v)).toBe(false);
  });
  it("requires active scoped company, worker and CEO policies", () => {
    const v = cardWorkFixture(); v.evidence.overview.policies.pop(); expect(cardAccountingReady("company", "morgan", "ceo", v.evidence.runs, v.evidence.overview)).toBe(false);
  });
});
it("requires the same real successful generation read before the later failure", () => {
  const v = successfulCardWorkFixture("new-worker-run", "refresh-task", "new-update");
  const ok = () => genuineCardChecklistSuccess("card", v.evidence.recipe, v.update, v.evidence); expect(ok()).toBe(true);
  v.evidence.calls[0]!.toolError = true; expect(ok()).toBe(false); v.evidence.calls[0]!.toolError = false;
  v.evidence.generation.status = "blocked"; expect(ok()).toBe(false); v.evidence.generation.status = "done";
  v.update.cardId = "foreign"; expect(ok()).toBe(false);
});
it("keeps the recipe static and scope-compatible and changes only synthetic read availability", () => {
  const p = cardChecklistPurpose("project"); const instructions = cardChecklistInstructions("connection");
  expect(p).toContain("saved Launch tasks"); expect(p).toContain("Synthetic Launch Notes");
  expect(instructions).toContain("bounded changed-issue facts"); expect(instructions).toContain("required query/summary write-back sequence");
  expect(instructions).not.toMatch(/fail now|set.*blocked|PATCH|cancel|expected|canonical.query|Refresh the launch status card now/i);
  expect(notesReadResponse("actual source data", false)).toEqual({ content: [{ type: "text", text: "actual source data" }] });
  const failed = notesReadResponse("actual source data", true); expect(failed).toHaveProperty("isError", true); expect(JSON.stringify(failed)).not.toContain("actual source data");
  expect(JSON.stringify(failed)).not.toMatch(/block|status|summary|tool.call|PATCH|fail now/i);
});
