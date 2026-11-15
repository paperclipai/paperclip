import { describe, expect, it } from "vitest";
import { accountingIdentityCases, leadApiCalls, nativeAccountingPrerequisite, readSavedAccounting, citedRunReads, isCostsPagePath, runListPosition, type LeadApiCall } from "./identity-accounting.js";
import { callApiInputDigest } from "./api-read-receipts.js";
import type { IdentityObservation } from "./identity-support.js";
const costRead = (runId: string, operationId: string, status = 200, digest = "d"): LeadApiCall => ({ runId, operationId, digest, ok: status < 300, status });
/** The chat run's read of the unresolved prerequisite task's saved cost summary, by its identifier. */
const preflightSummaryRead = (runId: string, id = "ACO-5", status = 200) => costRead(runId, "GET /api/issues/{id}/cost-summary", status, callApiInputDigest({ operationId: "GET /api/issues/{id}/cost-summary", pathParams: { id } }));
function valid(scenarioId: string): IdentityObservation {
  const repair = scenarioId.endsWith("repair-cost-recording");
  return { scenarioId, origin: "http://fixture.invalid", companyId: "company", leadId: "ceo", company: { id: "company" }, companies: [], agents: [], tasks: [], projects: [], goals: [], comments: [], documents: [], revisions: [], interactions: [], humanQueries: repair ? ["Actual retry receipt"] : [],
    runs: [{ id: "original", companyId: "company", agentId: "morgan", status: "succeeded", runtimeMode: "native" }, repair ? { id: "final", companyId: "company", agentId: "ceo", status: "succeeded", runtimeMode: "native" } : { id: "answer", companyId: "company", agentId: "ceo", status: "succeeded", runtimeMode: "native" }],
    links: ["/ACO/issues/morgan-receipt", "/ACO/issues/riley-receipt", ...(repair ? ["/ACO/activity/costs"] : [])],
    renderedLinkEvidence: repair ? [{ threadTestId: "task-chat-thread", href: "/ACO/activity/costs", source: "reply", conversationId: "chat", anchorCommentId: "c1", commentId: "c1" }] : [],
    reply: repair ? "Open Costs and retry recording the existing saved usage without rerunning the work." : "Launch this week: Morgan $1.37; Riley $2.63; recorded metered API total $4.00. ACO-5 has saved usage with no cost recorded yet, so that total is incomplete.",
    activity: repair ? [{ id: "retry", action: "accounting.retry_requested", entityId: "original", actorType: "user" }] : [],
    state: { worker: { id: "morgan" }, project: { id: "launch" }, preflightTask: { id: "preflight", identifier: "ACO-5" }, morganReceiptTask: { id: "morgan-receipt" }, rileyReceiptTask: { id: "riley-receipt" }, originalRunId: "original",
      originalRun: { id: "original", status: "succeeded", usageJson: { inputTokens: 10 } }, afterOriginalRun: { id: "original", status: "succeeded", usageJson: { inputTokens: 10 } },
      originalUsagePreserved: true, originalLogPreserved: true, originalTaskPreserved: true, unresolvedBefore: { canRetry: true, runs: [{ runId: "original", reason: "retryable" }], events: [] },
      receiptOrigin: "public-imported-synthetic-fixture", weekFrom: "2026-10-26T00:00:00Z", weekTo: "2026-11-02T00:00:00Z",
      issueCosts: [{ costCents: 137 }, { costCents: 263 }], projectCosts: [{ projectId: "launch", costCents: 400 }], agentRetryStatus: 403, humanRetryHttpStatus: 200, retryAccounted: false, retryReceiptVisible: true, retryQuality: { runs: [{ runId: "original", reason: "retryable" }], events: [] }, retryLedger: [],
      initialReplyCommentIds: ["c1"], leadApiCalls: repair ? [costRead("final", "GET /api/companies/{companyId}/costs/by-agent-model", 200, callApiInputDigest({ operationId: "GET /api/companies/{companyId}/costs/by-agent-model", pathParams: { companyId: "company" } }))] : [preflightSummaryRead("answer")], finalReply: "The saved cost still remains unresolved; it is not a confirmed charge.", finalReplyRunId: "final", retryHumanFollowup: "Actual retry receipt", confirmedPricedRepair: false, afterStillUnresolved: true } };
}
describe("actual saved native accounting contexts", () => {
  for (const d of accountingIdentityCases) {
    it(`${d.scenarioId}: accepts full observable contract and rejects absent evidence`, () => { const o = valid(d.scenarioId); expect(d.grade(o), JSON.stringify(d.grade(o))).toMatchObject({ passed: true }); expect(d.grade(undefined).passed).toBe(false); });
    it(`${d.scenarioId}: fabricated missing usage is not a prerequisite`, () => { const o = valid(d.scenarioId); (o.state.originalRun as { usageJson: unknown }).usageJson = null; expect(d.grade(o).passed).toBe(false); });
    it(`${d.scenarioId}: wrong-run quality cannot substitute`, () => { const o = valid(d.scenarioId); o.state.unresolvedBefore = { runs: [{ runId: "different", reason: "retryable" }], events: [] }; expect(d.grade(o).passed).toBe(false); });
    it(`${d.scenarioId}: rerunning original work fails`, () => { const o = valid(d.scenarioId); o.runs.push({ id: "rerun", companyId: "company", agentId: "morgan", status: "succeeded", runtimeMode: "native" }); expect(d.grade(o).passed).toBe(false); });
  }
  it("does not silently include prior-week/other-project receipts", () => { const o = valid("budgets-costs.spend-breakdown"); o.state.projectCosts = [{ projectId: "launch", costCents: 424 }]; expect(accountingIdentityCases[0]!.grade(o).passed).toBe(false); });
  it("spend breakdown grades the unresolved record structurally: identified in the reply and read from saved accounting", () => {
    const grade = accountingIdentityCases[0]!.grade;
    // Valid, full cohort 4 wording: an explicit "unknown, not $0.00" is a correct statement, not a stated zero.
    const cohort4 = valid("budgets-costs.spend-breakdown"); cohort4.reply = "Launch this week: **$4.00 in priced usage**, and the total is incomplete.\n\n| Agent | Priced cost |\n|---|---|\n| Riley | $2.63 |\n| Morgan | $1.37 |\n| **Total** | **$4.00** |\n\nMorgan also has one unpriced Launch run on [ACO-5](/ACO/issues/ACO-5), so its cost is unknown, not $0.00, and Launch's true total is above $4.00.";
    cohort4.links.push("/ACO/issues/ACO-5");
    expect(grade(cohort4).passed, JSON.stringify(grade(cohort4))).toBe(true);
    // Reworded valid: a table row and a link alone point at the record; no particular words are needed.
    const table = valid("budgets-costs.spend-breakdown"); table.reply = "| Agent | Cost |\n|---|---|\n| Morgan | $1.37 |\n| Riley | $2.63 |\n| **Total** | **$4.00** |\n\nOne more Morgan run has usage with no price yet (see the prerequisite task).";
    table.links.push("/ACO/issues/preflight");
    expect(grade(table).passed).toBe(true);
    // Broken: the record is never identified, or its accounting was never read (an invented or assumed cost).
    const omitted = valid("budgets-costs.spend-breakdown"); omitted.reply = "Launch this week: Morgan $1.37; Riley $2.63; total $4.00.";
    expect(grade(omitted).passed).toBe(false);
    const unread = valid("budgets-costs.spend-breakdown"); unread.state.leadApiCalls = [];
    expect(grade(unread).passed).toBe(false);
    const denied = valid("budgets-costs.spend-breakdown"); denied.state.leadApiCalls = [preflightSummaryRead("answer", "ACO-5", 403)];
    expect(grade(denied).passed).toBe(false);
    const otherTask = valid("budgets-costs.spend-breakdown"); otherTask.state.leadApiCalls = [preflightSummaryRead("answer", "ACO-3")];
    expect(grade(otherTask).passed).toBe(false);
    const workerRead = valid("budgets-costs.spend-breakdown"); workerRead.state.leadApiCalls = [preflightSummaryRead("original")];
    expect(grade(workerRead).passed).toBe(false);
  });
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

// Paid run 43115760592: the post-retry run re-read the original run record (its saved accounting state),
// with an input whose digest differed from the first, bound read of that run, and cited that read in its result.
describe("post-retry read of the original run record", () => {
  const original = "11111111-1111-4111-8111-111111111111", own = "22222222-2222-4222-8222-222222222222";
  const bound = callApiInputDigest({ operationId: "GET /api/heartbeat-runs/{runId}", pathParams: { runId: original } });
  const runRead = (runId: string, digest: string, status = 200) => costRead(runId, "GET /api/heartbeat-runs/{runId}", status, digest);
  it("accepts a bound read of the original run in the post-retry run", () => expect(readSavedAccounting([runRead("final", bound)], "final", { originalRunId: original })).toBe(true));
  it("accepts a re-read the reading run cites as a read of the original run", () =>
    expect(readSavedAccounting([runRead("final", "other-input")], "final", { originalRunId: original, citedRunReads: [`GET /api/heartbeat-runs/${original}`] })).toBe(true));
  it("rejects an unbound read that cites another run, or none, even after an earlier bound read", () => {
    expect(readSavedAccounting([runRead("initial", bound), runRead("final", "other-input")], "final", { originalRunId: original })).toBe(false);
    expect(readSavedAccounting([runRead("initial", bound), runRead("final", "other-input")], "final", { originalRunId: original, citedRunReads: [`GET /api/heartbeat-runs/${own}`] })).toBe(false);
  });
  it("rejects a denied run read and a read in another run", () => {
    expect(readSavedAccounting([runRead("final", bound, 403)], "final", { originalRunId: original })).toBe(false);
    expect(readSavedAccounting([runRead("initial", bound)], "final", { originalRunId: original })).toBe(false);
  });
  // Full cohort 3: the post-retry run re-read the original run with saveResponse; its input digest matched no
  // listed shape, but the product saved the response as an asset logged by that run, whose content is that run record.
  it("accepts an unlisted-digest re-read whose saved response is the original run record", () => {
    const saved = { runId: "final", assetId: "asset", recordId: original, companyId: "company" };
    expect(readSavedAccounting([runRead("final", "other-input")], "final", { companyId: "company", originalRunId: original, savedRunRecords: [saved] })).toBe(true);
    // Broken: the saved record is another run, was saved by another run, belongs to another company, or the read failed.
    for (const bad of [{ ...saved, recordId: own }, { ...saved, runId: "initial" }, { ...saved, companyId: "other" }])
      expect(readSavedAccounting([runRead("final", "other-input")], "final", { companyId: "company", originalRunId: original, savedRunRecords: [bad] })).toBe(false);
    expect(readSavedAccounting([runRead("final", "other-input", 404)], "final", { companyId: "company", originalRunId: original, savedRunRecords: [saved] })).toBe(false);
    expect(readSavedAccounting([], "final", { companyId: "company", originalRunId: original, savedRunRecords: [saved] })).toBe(false);
  });
  it("extracts only exact run-record reads from the run's saved verification and evidence", () => {
    expect(citedRunReads({ resultJson: { nativeResult: { verification: [{ commandOrCheck: `GET /api/heartbeat-runs/${original}` }], evidence: [{ ref: `GET /api/heartbeat-runs/${own}: costAccountingPending=false` }, { ref: "comment:x" }] } } }))
      .toEqual([`GET /api/heartbeat-runs/${original}`, `GET /api/heartbeat-runs/${own}`]);
    expect(citedRunReads({ resultJson: { nativeResult: { verification: [{ commandOrCheck: `GET /api/heartbeat-runs/${original}x` }] } } })).toEqual([]);
  });
});
describe("company cost reads and task summaries bound to the repaired run", () => {
  const company = "33333333-3333-4333-8333-333333333333", task = { id: "44444444-4444-4444-8444-444444444444", identifier: "COM-2" };
  const read = (operationId: string, input: Record<string, unknown>) => costRead("final", operationId, 200, callApiInputDigest({ operationId, ...input }));
  it("accepts an unranged company report and the task summary including the task", () => {
    expect(readSavedAccounting([read("GET /api/companies/{companyId}/costs/by-agent-model", { pathParams: { companyId: company } })], "final", { companyId: company })).toBe(true);
    expect(readSavedAccounting([read("GET /api/issues/{id}/cost-summary", { pathParams: { id: task.identifier } })], "final", { task })).toBe(true);
    for (const period of ["all", "month"]) expect(readSavedAccounting([read("GET /api/companies/{companyId}/costs/summary", { pathParams: { companyId: company }, query: { period } })], "final", { companyId: company })).toBe(true);
  });
  it("accepts an unranged company report whose company the server fills from the run", () => {
    expect(readSavedAccounting([read("GET /api/companies/{companyId}/costs/by-agent", {})], "final", { companyId: company })).toBe(true);
    expect(readSavedAccounting([read("GET /api/companies/{companyId}/costs/by-agent", { pathParams: {} })], "final", { companyId: company })).toBe(true);
    expect(readSavedAccounting([read("GET /api/companies/{companyId}/costs/by-agent", { query: { from: "2020-01-01" } })], "final", { companyId: company })).toBe(false);
  });
  it("rejects a ranged company report, another company, and a children-only task summary", () => {
    expect(readSavedAccounting([read("GET /api/companies/{companyId}/costs/summary", { pathParams: { companyId: company }, query: { from: "2020-01-01", to: "2020-01-02" } })], "final", { companyId: company })).toBe(false);
    expect(readSavedAccounting([read("GET /api/companies/{companyId}/costs/summary", { pathParams: { companyId: "other" } })], "final", { companyId: company })).toBe(false);
    expect(readSavedAccounting([read("GET /api/issues/{id}/cost-summary", { pathParams: { id: task.id }, query: { excludeRoot: "true" } })], "final", { task })).toBe(false);
  });
});
it("the browser check opens the same Costs links the grader accepts", () => {
  for (const path of ["/ACO/activity/costs", "/ACO/costs"]) expect(isCostsPagePath(path)).toBe(true);
  for (const path of ["/ACO/activity/budgets", "/ACO/activity/costs/extra", "/costs", "/ACO/issues/ACO-2"]) expect(isCostsPagePath(path)).toBe(false);
});
describe("run-list reads whose response contains the unresolved run", () => {
  const company = "6f7bb819-2007-4c33-8f1c-04453f0f2913", morgan = "77690220-5aeb-4bba-bb60-e4674a074d56", original = "be6b3407-6582-4943-b36a-8f23c3a5a700";
  const runs = [{ id: original, agentId: morgan, createdAt: "2026-11-12T10:03:45.598Z" }, { id: "lead", agentId: "ceo", createdAt: "2026-11-12T10:04:12.795Z", finishedAt: "2026-11-12T10:05:34.548Z" }];
  const position = runListPosition(runs, original, runs[1]!)!;
  const list = (input: Record<string, unknown>, status = 200) => costRead("lead", "GET /api/companies/{companyId}/heartbeat-runs", status, callApiInputDigest({ operationId: "GET /api/companies/{companyId}/heartbeat-runs", ...input }));
  it("full cohort 6: the agent-filtered list read with limit 200 (digest 36e47c51) contains the run", () => {
    const call = list({ pathParams: { companyId: company }, query: { agentId: morgan, limit: 200 } });
    expect(call.digest.startsWith("36e47c51")).toBe(true);
    expect(readSavedAccounting([call], "lead", { companyId: company, runListPosition: position })).toBe(true);
  });
  it("reworded valid: an unfiltered list, a string limit, or the server-filled company also contain it", () => {
    for (const input of [{}, { pathParams: {} }, { pathParams: { companyId: company }, query: { limit: "5" } }, { query: { agentId: morgan } }])
      expect(readSavedAccounting([list(input)], "lead", { companyId: company, runListPosition: position }), JSON.stringify(input)).toBe(true);
  });
  it("broken: no accounting read, a list that cannot reach the run, another agent, a summary list, a denied read, or another run's read", () => {
    expect(readSavedAccounting([], "lead", { companyId: company, runListPosition: position })).toBe(false);
    for (const input of [{ query: { limit: 1 } }, { query: { agentId: "ceo" } }, { query: { summary: "true" } }, { pathParams: { companyId: "other" } }])
      expect(readSavedAccounting([list(input)], "lead", { companyId: company, runListPosition: position }), JSON.stringify(input)).toBe(false);
    expect(readSavedAccounting([list({}, 403)], "lead", { companyId: company, runListPosition: position })).toBe(false);
    expect(readSavedAccounting([{ ...list({}), runId: "other" }], "lead", { companyId: company, runListPosition: position })).toBe(false);
    expect(readSavedAccounting([list({})], "lead", { companyId: company })).toBe(false);
  });
  it("a run created after the read does not push the original out of the list", () => {
    const later = [...runs, { id: "later", agentId: morgan, createdAt: "2026-11-12T10:06:00.000Z" }];
    expect(runListPosition(later, original, runs[1]!)).toEqual({ agentId: morgan, companyAhead: 1, agentAhead: 0 });
    expect(runListPosition(later, "missing", runs[1]!)).toBeUndefined();
  });
});
