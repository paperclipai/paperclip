import { it, expect } from "vitest";
import { gradeResumeAgent } from "./runtime-resume.js";
function valid(): any {
  const worker = { id: "morgan", companyId: "company" };
  return { scenarioId: "agents.resume-agent", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo",
    state: { worker, firstRunIds: ["first"], firstResumedWorker: { ...worker, lifecycleState: "ready", status: "idle", lifecycleHolds: [] },
      firstReply: "Morgan is resumed and available for future work.", secondBudgetHardStop: true, secondBudgetAmount: 100, secondBudgetPolicyActive: true, syntheticReceiptId: "imported-receipt", syntheticReceiptOrigin: "public-imported-synthetic-fixture", secondBudgetIncidentOpen: true,
      secondReply: "The budget cap remains a hold; Morgan cannot pick up work before it is resolved." },
    agents: [{ ...worker, status: "paused", lifecycleHolds: ["budget"] }], tasks: [], links: ["/ACORN/agents/morgan"], reply: "",
    activity: [{ id: "resume", action: "agent.resumed", entityId: "morgan", agentId: "ceo", runId: "first" }] as Array<Record<string, unknown>>,
    runs: [{ id: "first", agentId: "ceo", status: "succeeded" }, { id: "second", agentId: "ceo", status: "succeeded" }], humanQueries: [] };
}
it("accepts both saved availability and independently bound held-phase evidence", () => expect(gradeResumeAgent(valid()).passed).toBe(true));
it("accepts natural phase-specific ready and remaining-hold reports", () => { const o = valid(); o.state.firstReply = "Morgan has resumed and is available to take future assignments."; o.state.secondReply = "The budget hold still blocks Morgan, so this employee cannot take more work until the cap is addressed."; expect(gradeResumeAgent(o).passed).toBe(true); });
it("rejects missing resume evidence", () => expect(gradeResumeAgent(undefined).passed).toBe(false));
it("rejects first-phase prose borrowed to fake a successful saved resume", () => {
  const o = valid(); o.state.firstResumedWorker.status = "paused"; expect(gradeResumeAgent(o).passed).toBe(false);
});
it("rejects using the first reply instead of evidence from the held request", () => {
  const o = valid(); o.state.secondReply = o.state.firstReply; expect(gradeResumeAgent(o).passed).toBe(false);
});
it("rejects silently clearing the remaining budget gate", () => {
  const o = valid(); o.agents[0]!.lifecycleHolds = []; expect(gradeResumeAgent(o).passed).toBe(false);
});
it("rejects pretending a new worker execution already started", () => {
  const o = valid(); o.runs.push({ id: "worker", agentId: "morgan", status: "succeeded" }); expect(gradeResumeAgent(o).passed).toBe(false);
});

it("rejects the unenforced zero-cap fixture and missing real incident", () => {
  const o = valid(); o.state.secondBudgetAmount = 0; expect(gradeResumeAgent(o).passed).toBe(false);
  o.state.secondBudgetAmount = 100; o.state.secondBudgetIncidentOpen = false; expect(gradeResumeAgent(o).passed).toBe(false);
});
it("rejects a synthetic receipt misrepresented as provider spending", () => {
  const o = valid(); o.state.syntheticReceiptOrigin = "actual-provider-usage"; expect(gradeResumeAgent(o).passed).toBe(false);
});

it("accepts meaning-preserving wording the old phrase lists rejected", () => {
  const o = valid();
  o.state.firstReply = "Done: Morgan is back on. Morgan hasn't started the work yet; a new assignment will start a run.";
  o.state.secondReply = "Morgan is still held: their monthly allowance is exhausted, so a board member has to raise it first.";
  expect(gradeResumeAgent(o).passed).toBe(true);
});
it("rejects a resume performed outside the first request's own run", () => {
  const o = valid(); o.activity[0].runId = "second"; expect(gradeResumeAgent(o).passed).toBe(false);
});
it("rejects the CEO lifting the budget hard stop through an agent update", () => {
  const o = valid();
  o.activity.push({ id: "raise", action: "agent.updated", entityId: "morgan", agentId: "ceo", runId: "second", details: { changedTopLevelKeys: ["budgetMonthlyCents"] } });
  expect(gradeResumeAgent(o).passed).toBe(false);
  const p = valid(); p.activity.push({ id: "policy", action: "budget.policy_upserted", entityId: "policy", agentId: "ceo", runId: "second" });
  expect(gradeResumeAgent(p).passed).toBe(false);
});
it("rejects a missing reply to the held request", () => {
  const o = valid(); o.state.secondReply = ""; expect(gradeResumeAgent(o).passed).toBe(false);
});
it("rejects a missing link to the affected Morgan", () => {
  const o = valid(); o.links = ["/ACORN/agents/ceo/overview"]; expect(gradeResumeAgent(o).passed).toBe(false);
});
