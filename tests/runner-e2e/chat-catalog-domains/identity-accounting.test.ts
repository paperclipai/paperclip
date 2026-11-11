import { describe, expect, it } from "vitest";
import { accountingIdentityCases, leadApiCalls, nativeAccountingPrerequisite, type LeadApiCall } from "./identity-accounting.js";
import { callApiInputDigest } from "./api-read-receipts.js";
import type { IdentityObservation } from "./identity-support.js";
const costRead = (runId: string, operationId: string, status = 200, digest = "d"): LeadApiCall => ({ runId, operationId, digest, ok: status < 300, status });
function valid(scenarioId: string): IdentityObservation {
  const repair = scenarioId.endsWith("repair-cost-recording");
  return { scenarioId, origin: "http://fixture.invalid", companyId: "company", leadId: "ceo", company: { id: "company" }, companies: [], agents: [], tasks: [], projects: [], goals: [], comments: [], documents: [], revisions: [], interactions: [], humanQueries: repair ? ["Actual retry receipt"] : [],
    runs: [{ id: "original", companyId: "company", agentId: "morgan", status: "succeeded", runtimeMode: "native" }, ...(repair ? [{ id: "final", companyId: "company", agentId: "ceo", status: "succeeded", runtimeMode: "native" }] : [])],
    links: ["/ACO/issues/morgan-receipt", "/ACO/issues/riley-receipt", ...(repair ? ["/ACO/activity/costs"] : [])],
    renderedLinkEvidence: repair ? [{ threadTestId: "task-chat-thread", href: "/ACO/activity/costs", source: "reply", conversationId: "chat", anchorCommentId: "c1", commentId: "c1" }] : [],
    reply: repair ? "Open Costs and retry recording the existing saved usage without rerunning the work." : "Launch this week: Morgan $1.37; Riley $2.63; recorded metered API total $4.00. ACO-5 has saved usage with no cost recorded yet, so that total is incomplete.",
    activity: repair ? [{ id: "retry", action: "accounting.retry_requested", entityId: "original", actorType: "user" }] : [],
    state: { worker: { id: "morgan" }, project: { id: "launch" }, preflightTask: { id: "preflight", identifier: "ACO-5" }, morganReceiptTask: { id: "morgan-receipt" }, rileyReceiptTask: { id: "riley-receipt" }, originalRunId: "original",
      originalRun: { id: "original", status: "succeeded", usageJson: { inputTokens: 10 } }, afterOriginalRun: { id: "original", status: "succeeded", usageJson: { inputTokens: 10 } },
      originalUsagePreserved: true, originalLogPreserved: true, originalTaskPreserved: true, unresolvedBefore: { canRetry: true, runs: [{ runId: "original", reason: "retryable" }], events: [] },
      receiptOrigin: "public-imported-synthetic-fixture", weekFrom: "2026-10-26T00:00:00Z", weekTo: "2026-11-02T00:00:00Z",
      issueCosts: [{ costCents: 137 }, { costCents: 263 }], projectCosts: [{ projectId: "launch", costCents: 400 }], agentRetryStatus: 403, humanRetryHttpStatus: 200, retryAccounted: false, retryReceiptVisible: true, retryQuality: { runs: [{ runId: "original", reason: "retryable" }], events: [] }, retryLedger: [],
      initialReplyCommentIds: ["c1"], leadApiCalls: repair ? [costRead("final", "GET /api/companies/{companyId}/costs/by-agent-model")] : [], finalReply: "The saved cost still remains unresolved; it is not a confirmed charge.", finalReplyRunId: "final", retryHumanFollowup: "Actual retry receipt", confirmedPricedRepair: false, afterStillUnresolved: true } };
}
describe("actual saved native accounting contexts", () => {
  for (const d of accountingIdentityCases) {
    it(`${d.scenarioId}: accepts full observable contract and rejects absent evidence`, () => { const o = valid(d.scenarioId); expect(d.grade(o), JSON.stringify(d.grade(o))).toMatchObject({ passed: true }); expect(d.grade(undefined).passed).toBe(false); });
    it(`${d.scenarioId}: fabricated missing usage is not a prerequisite`, () => { const o = valid(d.scenarioId); (o.state.originalRun as { usageJson: unknown }).usageJson = null; expect(d.grade(o).passed).toBe(false); });
    it(`${d.scenarioId}: wrong-run quality cannot substitute`, () => { const o = valid(d.scenarioId); o.state.unresolvedBefore = { runs: [{ runId: "different", reason: "retryable" }], events: [] }; expect(d.grade(o).passed).toBe(false); });
    it(`${d.scenarioId}: rerunning original work fails`, () => { const o = valid(d.scenarioId); o.runs.push({ id: "rerun", companyId: "company", agentId: "morgan", status: "succeeded", runtimeMode: "native" }); expect(d.grade(o).passed).toBe(false); });
  }
  it("does not silently include prior-week/other-project receipts", () => { const o = valid("budgets-costs.spend-breakdown"); o.state.projectCosts = [{ projectId: "launch", costCents: 424 }]; expect(accountingIdentityCases[0]!.grade(o).passed).toBe(false); });
  it("spend breakdown accepts any wording that points at the unresolved record and rejects a $0.00 row or an omitted record", () => {
    const grade = accountingIdentityCases[0]!.grade;
    const table = valid("budgets-costs.spend-breakdown"); table.reply = "| Agent | Cost |\n|---|---|\n| Morgan | $1.37 |\n| Riley | $2.63 |\n| **Total** | **$4.00** |\n\nRun original (Morgan, [ACO-5](/ACO/issues/ACO-5)) has usage but no cost event yet; it is not included above.";
    expect(grade(table).passed).toBe(true);
    const zero = valid("budgets-costs.spend-breakdown"); zero.reply = "| Agent | Cost | Task |\n|---|---|---|\n| Morgan | $1.37 | receipt |\n| Riley | $2.63 | receipt |\n| Morgan | $0.00 | [ACO-5](/ACO/issues/ACO-5) (usage recorded, no cost event) |\n| **Total** | **$4.00** | |";
    expect(grade(zero).passed).toBe(false);
    const omitted = valid("budgets-costs.spend-breakdown"); omitted.reply = "Launch this week: Morgan $1.37; Riley $2.63; total $4.00.";
    expect(grade(omitted).passed).toBe(false);
  });
  it("spend breakdown grades only a $0 amount on the unresolved record, not words such as free", () => {
    const grade = accountingIdentityCases[0]!.grade; const base = "Launch this week: Morgan $1.37; Riley $2.63; total $4.00. ";
    for (const [tail, ok] of [["ACO-5 pending usage: $0.00.", false], ["ACO-5 must not be counted as free; its cost is not recorded yet.", true], ["ACO-5 is unpriced, so it contributes no dollar amount.", true]] as const) {
      const o = valid("budgets-costs.spend-breakdown"); o.reply = base + tail; expect(grade(o).passed, tail).toBe(ok);
    }
  });

  it("does not count unresolved native usage as free", () => { const o = valid("budgets-costs.spend-breakdown"); o.reply += " ACO-5 pending usage: $0.00."; expect(accountingIdentityCases[0]!.grade(o).passed).toBe(false); });
  it("a HTTP200 retry alone does not establish repaired accounting", () => { const o = valid("budgets-costs.repair-cost-recording"); o.state.afterStillUnresolved = false; expect(accountingIdentityCases[1]!.grade(o).passed).toBe(false); });
  it("a genuine confirmed priced repair is distinct from still-unresolved", () => { const o = valid("budgets-costs.repair-cost-recording"); o.state.confirmedPricedRepair = true; o.state.afterStillUnresolved = false; o.state.retryAccounted = true; o.state.retryQuality = { runs: [], events: [] }; o.state.retryLedger = [{ agentId: "morgan", eventCount: 1, estimatedEventCount: 0 }]; o.state.finalReply = "The saved usage cost is now recorded. The original work was not rerun."; expect(accountingIdentityCases[1]!.grade(o).passed).toBe(true); });
  it("grades no reply wording: reworded guidance and explanations pass on the same saved evidence", () => {
    for (const [initial, final] of [["Head to Costs, open Ready to record and press the button there; the work stays as it is.", "Not yet: Costs shows the usage with no price, so it is still unconfirmed."],
      ["Only you can do this one. [Costs](/ACO/activity/costs) has the control.", "Yes. Morgan's usage now shows a recorded charge."]] as const) {
      const o = valid("budgets-costs.repair-cost-recording"); o.reply = initial; o.state.finalReply = final; expect(accountingIdentityCases[1]!.grade(o).passed, final).toBe(true);
    }
  });
  it("requires the Costs page link in the guidance given before the retry", () => {
    const grade = accountingIdentityCases[1]!.grade;
    const none = valid("budgets-costs.repair-cost-recording"); none.renderedLinkEvidence = []; expect(grade(none).passed).toBe(false);
    const late = valid("budgets-costs.repair-cost-recording"); late.renderedLinkEvidence = [{ ...late.renderedLinkEvidence![0]!, commentId: "c-final", anchorCommentId: "c-final" }]; expect(grade(late).passed).toBe(false);
    const runOnly = valid("budgets-costs.repair-cost-recording"); runOnly.renderedLinkEvidence = [{ ...runOnly.renderedLinkEvidence![0]!, href: "/ACO/agents/morgan/runs/original" }]; expect(grade(runOnly).passed).toBe(false);
    const legacy = valid("budgets-costs.repair-cost-recording"); legacy.renderedLinkEvidence = [{ ...legacy.renderedLinkEvidence![0]!, href: "/ACO/costs" }]; expect(grade(legacy).passed).toBe(true);
    const foreign = valid("budgets-costs.repair-cost-recording"); foreign.renderedLinkEvidence = [{ ...foreign.renderedLinkEvidence![0]!, href: "https://elsewhere.invalid/ACO/activity/costs" }]; expect(grade(foreign).passed).toBe(false);
  });
  it("the post-retry answer must come from a fresh saved-accounting read in that run", () => {
    const grade = accountingIdentityCases[1]!.grade;
    const unread = valid("budgets-costs.repair-cost-recording"); unread.state.leadApiCalls = []; expect(grade(unread).passed).toBe(false);
    const early = valid("budgets-costs.repair-cost-recording"); early.state.leadApiCalls = [costRead("initial", "GET /api/companies/{companyId}/costs/by-agent-model")]; expect(grade(early).passed).toBe(false);
    const denied = valid("budgets-costs.repair-cost-recording"); denied.state.leadApiCalls = [costRead("final", "GET /api/companies/{companyId}/costs/data-quality", 403)]; expect(grade(denied).passed).toBe(false);
    const unrelated = valid("budgets-costs.repair-cost-recording"); unrelated.state.leadApiCalls = [costRead("final", "GET /api/heartbeat-runs/{runId}")]; expect(grade(unrelated).passed).toBe(false);
    const task = valid("budgets-costs.repair-cost-recording"); task.state.leadApiCalls = [costRead("final", "GET /api/issues/{id}/cost-summary", 200, callApiInputDigest({ operationId: "GET /api/issues/{id}/cost-summary", pathParams: { id: "ACO-5" } }))]; expect(grade(task).passed).toBe(true);
    const otherTask = valid("budgets-costs.repair-cost-recording"); otherTask.state.leadApiCalls = [costRead("final", "GET /api/issues/{id}/cost-summary", 200, callApiInputDigest({ operationId: "GET /api/issues/{id}/cost-summary", pathParams: { id: "ACO-9" } }))]; expect(grade(otherTask).passed).toBe(false);
  });
  it("an agent-written cost or a run it starts fails; a denied retry attempt does not", () => {
    const grade = accountingIdentityCases[1]!.grade;
    for (const operationId of ["POST /api/companies/{companyId}/cost-events", "POST /api/companies/{companyId}/accounting/events/{eventId}/adjustments", "POST /api/issues/{id}/retry", "POST /api/agents/{id}/wakeup"]) {
      const o = valid("budgets-costs.repair-cost-recording"); (o.state.leadApiCalls as LeadApiCall[]).push(costRead("initial", operationId, 201)); expect(grade(o).passed, operationId).toBe(false);
    }
    const denied = valid("budgets-costs.repair-cost-recording"); (denied.state.leadApiCalls as LeadApiCall[]).push(costRead("initial", "POST /api/companies/{companyId}/costs/retry-accounting", 403)); expect(grade(denied).passed).toBe(true);
    const comment = valid("budgets-costs.repair-cost-recording"); (comment.state.leadApiCalls as LeadApiCall[]).push(costRead("initial", "POST /api/issues/{id}/comments", 201)); expect(grade(comment).passed).toBe(true);
  });
  it("pairs redacted call_api uses with their results by run and item id", () => {
    const use = (runId: string, id: string, operationId: string) => ({ runId, payload: { prpEvent: { payload: { item: { type: "tool_use", name: "call_api", id, input: { operationId, apiPayloadRedacted: true, apiPayloadSha256: `sha-${id}` } } } } } });
    const result = (runId: string, id: string, apiOperationId: string, status: number) => ({ runId, payload: { prpEvent: { payload: { item: { type: "tool_result", tool_use_id: id, result: { apiOperationId, ok: status < 300, status } } } } } });
    expect(leadApiCalls([use("r1", "a", "GET /x"), result("r1", "a", "GET /x", 200), use("r1", "b", "POST /y"), result("r2", "b", "POST /y", 201), result("r1", "b", "GET /z", 200)]))
      .toEqual([{ runId: "r1", operationId: "GET /x", digest: "sha-a", ok: true, status: 200 }]);
  });
  it("an earlier reply cannot substitute for the distinct post-action native reply", () => { const o = valid("budgets-costs.repair-cost-recording"); o.state.finalReplyRunId = "original"; expect(accountingIdentityCases[1]!.grade(o).passed).toBe(false); });
  it("a price-estimate ledger cannot substitute for confirmed recording", () => { const o = valid("budgets-costs.repair-cost-recording"); o.state.confirmedPricedRepair = true; o.state.retryLedger = [{ agentId: "morgan", eventCount: 1, estimatedEventCount: 1 }]; expect(accountingIdentityCases[1]!.grade(o).passed).toBe(false); });
  it("no hidden human receipt or missing phase may pass", () => { const o = valid("budgets-costs.repair-cost-recording"); o.humanQueries = []; expect(accountingIdentityCases[1]!.grade(o).passed).toBe(false); });
  it("an actual agent retry bypass fails", () => { const o = valid("budgets-costs.repair-cost-recording"); o.state.agentRetryStatus = 200; expect(accountingIdentityCases[1]!.grade(o).passed).toBe(false); });
});

describe("saved-run retry prerequisite classification", () => {
  const run = { id: "original", status: "succeeded" as const, usageJson: { inputTokens: 10 } };
  const item = { id: "original", runId: "original", agentId: "morgan", agentName: "Morgan", occurredAt: "2026-10-27T00:00:00Z", provider: "openai", model: "actual" };
  const quality = { canRetry: true, runs: [{ ...item, reason: "retryable" as const }], events: [], hasMoreRuns: false, hasMoreEvents: false };
  it("accepts genuine pending saved usage exposed by the public retry control", () => {
    expect(nativeAccountingPrerequisite(run, quality, true)).toMatchObject({ eligible: true, disposition: "eligible", retryControlAvailable: true });
  });
  it("does not mistake acknowledged unknown billing for settled or retryable accounting", () => {
    const q = { ...quality, runs: [], events: [{ ...item, reason: "unknown_billing" as const }] };
    expect(nativeAccountingPrerequisite(run, q, true)).toMatchObject({ eligible: false, disposition: "unresolved-without-saved-run-retry", unresolvedReasons: ["unknown_billing"] });
    expect(nativeAccountingPrerequisite(run, q, false).eligible).toBe(true);
  });
  it("rejects missing usage, foreign-run debt, event-only retry labels and unauthorized retry", () => {
    expect(nativeAccountingPrerequisite({ ...run, usageJson: null }, quality, true).eligible).toBe(false);
    expect(nativeAccountingPrerequisite(run, { ...quality, runs: [{ ...item, runId: "foreign", reason: "retryable" }] }, true).eligible).toBe(false);
    expect(nativeAccountingPrerequisite(run, { ...quality, runs: [], events: quality.runs }, true).eligible).toBe(false);
    expect(nativeAccountingPrerequisite(run, { ...quality, canRetry: false }, true).eligible).toBe(false);
    expect(nativeAccountingPrerequisite(run, { ...quality, runs: [] }, true).disposition).toBe("settled-accounting");
  });
});
