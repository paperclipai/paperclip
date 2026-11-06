import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BudgetOverview } from "../../../packages/shared/src/types/budget.js";
import { gradeIntegratorRoutineHistory, integratorRoutineHistoryCases } from "./integrator-routine-history.js";
import { completeHistoryUsage, genuineHistoryWork, routineHistoryAccountingReady, type HistoryWorkIdentity, type HistoryWorkSnapshot } from "./routine-history-work-failure.js";

function phase(failed: boolean) {
  const prefix = failed ? "failed" : "completed";
  const identity: HistoryWorkIdentity = { companyId: "company", agentId: "worker", issueId: `${prefix}-task`, runId: `${prefix}-native`, routineId: "routine", invocationId: `${prefix}-invocation`, connectionId: "notes", writeEntryId: "write-entry" };
  const at = failed ? "2026-10-26T12:00:00Z" : "2026-10-26T13:00:00Z";
  const requestId = `${prefix}-http-request`;
  const run = { id: identity.runId, companyId: "company", agentId: "worker", runtimeMode: "native", status: "succeeded", startedAt: at, finishedAt: at,
    contextSnapshot: { issueId: identity.issueId }, costAccountingPending: false, costAccountedAt: at,
    usageJson: { accountingReceiptReady: true, accountingReceiptSourceId: `${prefix}-source`, accountingReceiptId: `${prefix}-receipt`, accountingReceiptSequence: 2, accountingReceiptReceivedAt: at,
      usageSource: "per_run", provider: "opencode", biller: "openrouter", model: "actual-model", billingType: "metered_api", inputTokens: 100, outputTokens: 20, costUsd: 0.01 } };
  const task = { id: identity.issueId, companyId: "company", identifier: failed ? "ACORN-1" : "ACORN-2", title: "Morning Launch summary", status: failed ? "blocked" : "done", assigneeAgentId: "worker" };
  const snapshot = { run, task, invocation: { id: identity.invocationId, companyId: "company", routineId: "routine", source: "manual", status: failed ? "failed" : "completed", linkedIssueId: identity.issueId, triggeredAt: at, completedAt: at },
    decisions: { runId: run.id, decisions: [{ invocation: { id: `${prefix}-tool-invocation`, ...identity, policyDecision: "allow", status: failed ? "failed" : "succeeded", errorCode: failed ? "tool_error" : null, startedAt: at, completedAt: at, argumentsHash: "arguments-hash", resultHash: failed ? null : "result-hash", catalogEntryId: identity.writeEntryId },
      auditEvents: [{ invocationId: `${prefix}-tool-invocation`, companyId: "company", agentId: "worker", issueId: task.id, runId: run.id, connectionId: "notes", catalogEntryId: "write-entry", outcome: failed ? "failure" : "success", decision: failed ? "deny" : "allow", reasonCode: failed ? "tool_error" : "tool_completed",
        metadata: { execution: { transport: "mcp_remote", request: { dispatched: true, upstreamToolName: "launch_update", mcpMethod: "tools/call", requestId }, response: { httpStatus: 200 } } } }] }] },
    comments: [{ id: `${prefix}-comment`, issueId: task.id, authorAgentId: "worker", createdByRunId: run.id, body: failed ? "The synthetic Notes publish failed; task blocked." : "Published the Launch summary." }],
    activity: [{ id: `${prefix}-activity`, companyId: "company", entityId: task.id, runId: run.id, action: "issue.updated", actorType: "system", actorId: "native-status-committer", details: { source: "native_status_decision", toStatus: task.status } }] } as unknown as HistoryWorkSnapshot;
  const calls = [{ method: "tools/call", name: "launch_update", authorized: true, sequence: failed ? 1 : 2, requestIdSha256: createHash("sha256").update(requestId).digest("hex"), responseHttpStatus: 200, toolError: failed }];
  return { identity, snapshot, calls };
}
function valid() {
  const f = phase(true), s = phase(false);
  return { scenarioId: "routines.read-history", origin: "https://fixture.test", companyId: "company", leadId: "ceo", expectedProvider: "opencode",
    state: { worker: { id: "worker" }, failedIssueId: f.identity.issueId, completedIssueId: s.identity.issueId, failedInvocationId: f.identity.invocationId, completedInvocationId: s.identity.invocationId,
      failedIdentity: f.identity, completedIdentity: s.identity, failedWork: f.snapshot, completedWork: s.snapshot, failedCalls: f.calls, completedCalls: s.calls,
      failedWritten: null, completedWritten: "Launch payment approval remains pending.", completedNativeRunId: s.identity.runId, weekStart: Date.parse("2026-10-26T00:00:00Z"), weekEnd: Date.parse("2026-11-02T00:00:00Z") },
    routine: { id: "routine", title: "Morning Launch summary" }, executions: [f.snapshot.invocation!, s.snapshot.invocation!], tasks: [f.snapshot.task, s.snapshot.task], runs: [f.snapshot.run!, s.snapshot.run!],
    projects: [], goals: [], comments: [], documents: [], revisions: [], activity: [], humanQueries: [], links: ["/ACORN/issues/ACORN-1", "/ACORN/issues/ACORN-2"], reply: "ACORN-1 failed. ACORN-2 completed successfully. These are manual runs this week." };
}
function overview() {
  return { companyId: "company", policies: ["company", "agent"].map(scopeType => ({ companyId: "company", scopeType, scopeId: scopeType === "company" ? "company" : "worker", isActive: true, amount: 500, remainingAmount: 499, hardStopEnabled: true, unpricedUsagePolicy: "allow", pendingRunCount: 0, paused: false, status: "ok" })) } as BudgetOverview;
}
describe("real routine work failure with successful native turns", () => {
  it("accepts authoritative provider failure, blocked task and failed invocation, then independent success", () => {
    expect(genuineHistoryWork(phase(true).identity, phase(true).snapshot, phase(true).calls, true)).toBe(true);
    expect(genuineHistoryWork(phase(false).identity, phase(false).snapshot, phase(false).calls, false)).toBe(true);
    expect(gradeIntegratorRoutineHistory(valid()).passed).toBe(true);
  });
  const mutations: Array<[string, (p: ReturnType<typeof phase>) => void]> = [
    ["foreign company", p => { p.snapshot.run!.companyId = "foreign"; }],
    ["foreign worker", p => { p.snapshot.run!.agentId = "other"; }],
    ["foreign task", p => { p.snapshot.run!.contextSnapshot!.issueId = "other"; }],
    ["failed native provider", p => { p.snapshot.run!.status = "failed"; }],
    ["cancelled native", p => { p.snapshot.run!.status = "cancelled"; }],
    ["still running native", p => { p.snapshot.run!.finishedAt = null; }],
    ["manufactured failure narration", p => { p.snapshot.decisions.decisions = []; }],
    ["unchanged task status", p => { p.snapshot.task.status = "in_progress"; }],
    ["wrong task owner", p => { p.snapshot.task.assigneeAgentId = "other"; }],
    ["stale public invocation", p => { p.snapshot.invocation!.status = "issue_created"; }],
    ["foreign routine", p => { p.snapshot.invocation!.routineId = "other"; }],
    ["foreign invocation task", p => { p.snapshot.invocation!.linkedIssueId = "other"; }],
    ["scheduled substitute", p => { p.snapshot.invocation!.source = "schedule" as never; }],
    ["policy denial", p => { p.snapshot.decisions.decisions[0]!.invocation.policyDecision = "deny"; }],
    ["denied error", p => { p.snapshot.decisions.decisions[0]!.invocation.errorCode = "policy_denied"; }],
    ["foreign catalog", p => { p.snapshot.decisions.decisions[0]!.invocation.catalogEntryId = "other"; }],
    ["foreign connection", p => { p.snapshot.decisions.decisions[0]!.invocation.connectionId = "other"; }],
    ["foreign audit run", p => { p.snapshot.decisions.decisions[0]!.auditEvents[0]!.runId = "other"; }],
    ["missing audit", p => { p.snapshot.decisions.decisions[0]!.auditEvents = []; }],
    ["HTTP authorization rejection", p => { p.calls[0]!.responseHttpStatus = 401; }],
    ["unauthorized provider call", p => { p.calls[0]!.authorized = false; }],
    ["successful work claimed failure", p => { p.calls[0]!.toolError = false; }],
    ["unrelated HTTP receipt", p => { p.calls[0]!.requestIdSha256 = "other"; }],
    ["no provider call", p => { p.calls = []; }],
    ["human-authored block", p => { p.snapshot.activity[0]!.actorId = "board"; }],
    ["foreign block run", p => { p.snapshot.activity[0]!.runId = "other"; }],
    ["no worker failure report", p => { p.snapshot.comments = []; }],
    ["forged worker report", p => { p.snapshot.comments[0]!.createdByRunId = "other"; }],
  ];
  it.each(mutations)("rejects %s", (_name, mutate) => { const p = phase(true); mutate(p); expect(genuineHistoryWork(p.identity, p.snapshot, p.calls, true)).toBe(false); });
  it("retains week, separate task, failure/success, link and schedule-grounding controls", () => {
    for (const mutate of [
      (v: ReturnType<typeof valid>) => { v.executions[0]!.triggeredAt = "2026-10-19T00:00:00Z" as never; },
      (v: ReturnType<typeof valid>) => { v.executions.push(v.executions[0]!); },
      (v: ReturnType<typeof valid>) => { v.links.shift(); },
      (v: ReturnType<typeof valid>) => { v.reply = "All runs succeeded this week."; },
      (v: ReturnType<typeof valid>) => { v.reply += " Both scheduled morning summaries ran successfully."; },
      (v: ReturnType<typeof valid>) => { v.state.failedWritten = "changed" as never; },
      (v: ReturnType<typeof valid>) => { v.state.completedWritten = ""; },
    ]) { const v = valid(); mutate(v); expect(gradeIntegratorRoutineHistory(v).passed).toBe(false); }
    expect(gradeIntegratorRoutineHistory(undefined).passed).toBe(false);
  });
  it("declares exactly three normally succeeded turns and preserves original clocks", () => {
    const c = integratorRoutineHistoryCases[0]!;
    expect(c.runPolicy).toEqual({ kind: "terminal-counts", terminalStatusCounts: { succeeded: 3 } });
    expect([c.expectedRunCount, c.expectedHumanMessageCount, c.turnTimeoutMs, c.attemptTimeoutMs]).toEqual([3, 1, 120000, 720000]);
  });
});
describe("complete normal accounting stays mandatory", () => {
  it("accepts actual settled per-run receipt with positive recorded usage", () => { const p = phase(true); expect(completeHistoryUsage(p.snapshot.run)).toBe(true); expect(routineHistoryAccountingReady(p.identity, [p.snapshot.run!], overview())).toBe(true); });
  it.each([
    ["pending settlement", "costAccountingPending", true], ["no settlement", "costAccountedAt", null],
  ])("rejects %s", (_n, key, value) => { const p = phase(true); (p.snapshot.run as unknown as Record<string, unknown>)[String(key)] = value; expect(completeHistoryUsage(p.snapshot.run)).toBe(false); });
  it.each([
    ["partial receipt", "accountingReceiptReady", false], ["capture failed", "accountingCaptureFailed", true], ["bootstrap no-work", "accountingProviderWorkStarted", false],
    ["missing source", "accountingReceiptSourceId", null], ["missing id", "accountingReceiptId", null], ["missing sequence", "accountingReceiptSequence", 0],
    ["missing receipt time", "accountingReceiptReceivedAt", null], ["cumulative usage", "usageSource", "session_cumulative"], ["missing provider", "provider", "unknown"],
    ["no input usage", "inputTokens", null], ["string output usage", "outputTokens", "20"],
  ])("rejects %s", (_n, key, value) => { const p = phase(true); p.snapshot.run!.usageJson![String(key)] = value; expect(completeHistoryUsage(p.snapshot.run)).toBe(false); });
  it("accepts complete settled unpriced usage under explicit allow without inventing an amount", () => {
    const p = phase(true), u = p.snapshot.run!.usageJson!;
    u.costStatus = "unpriced"; u.costUsd = null; u.costUsdExact = null; u.accountingCostIncomplete = true;
    expect(completeHistoryUsage(p.snapshot.run)).toBe(true);
    expect(routineHistoryAccountingReady(p.identity, [p.snapshot.run!], overview())).toBe(true);
    expect([u.costUsd, u.costUsdExact]).toEqual([null, null]);
  });
  it("keeps unpriced-deny, stale/incomplete receipts, foreign runs and invented-zero readiness blocked", () => {
    const p = phase(true), u = p.snapshot.run!.usageJson!; u.costStatus = "unpriced"; u.costUsd = null; u.costUsdExact = null;
    const denied = overview(); denied.policies[0]!.unpricedUsagePolicy = "block";
    expect(routineHistoryAccountingReady(p.identity, [p.snapshot.run!], denied)).toBe(false);
    u.accountingReceiptReady = false; u.costUsd = 0;
    expect(routineHistoryAccountingReady(p.identity, [p.snapshot.run!], overview())).toBe(false);
    u.accountingReceiptReady = true; p.snapshot.run!.costAccountingPending = true;
    expect(routineHistoryAccountingReady(p.identity, [p.snapshot.run!], overview())).toBe(false);
    p.snapshot.run!.costAccountingPending = false; p.snapshot.run!.companyId = "foreign";
    expect(routineHistoryAccountingReady(p.identity, [p.snapshot.run!], overview())).toBe(false);
  });
  it("does not infer free work, bypass scoped pending/hard-stop policy or accept foreign accounting", () => {
    const p = phase(true); p.snapshot.run!.usageJson!.inputTokens = 0; p.snapshot.run!.usageJson!.outputTokens = 0; expect(completeHistoryUsage(p.snapshot.run)).toBe(false);
    for (const index of [0, 1]) { const o = overview(); o.policies[index]!.pendingRunCount = 1; expect(routineHistoryAccountingReady(phase(true).identity, [phase(true).snapshot.run!], o)).toBe(false); }
    const o = overview(); o.policies[0]!.paused = true; expect(routineHistoryAccountingReady(phase(true).identity, [phase(true).snapshot.run!], o)).toBe(false);
    const foreign = phase(true); foreign.identity.runId = "other"; expect(routineHistoryAccountingReady(foreign.identity, [foreign.snapshot.run!], overview())).toBe(false);
  });
});
