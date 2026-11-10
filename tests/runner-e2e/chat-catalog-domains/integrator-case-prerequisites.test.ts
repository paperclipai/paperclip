import { describe, expect, it, vi } from "vitest";
import type { BudgetOverview } from "../../../packages/shared/src/types/budget.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { caseCancellationAccountingReady, grantCaseTaskAssignment } from "./integrator-case-prerequisites.js";
const expected = { companyId: "company", agentId: "worker", issueId: "primary", runId: "cancelled-run" };
function ready() {
  return { run: { id: expected.runId, companyId: "company", agentId: "worker", issueId: "primary", status: "cancelled" as const, finishedAt: new Date() },
    nativeRun: { id: expected.runId, companyId: "company", agentId: "worker", status: "cancelled", runtimeMode: "native", contextSnapshot: { issueId: "primary" } },
    overview: { companyId: "company", policies: ["company", "agent"].map(scopeType => ({ companyId: "company", scopeType, scopeId: scopeType === "company" ? "company" : "worker", isActive: true, hardStopEnabled: true, amount: 500, remainingAmount: 499, unpricedUsagePolicy: "allow", pendingRunCount: 0, status: "ok", paused: false })) } as BudgetOverview };
}
describe("case prerequisite cancellation accounting", () => {
  it("accepts only matching genuinely cancelled native execution and observed funded scopes", () => { expect(caseCancellationAccountingReady(expected, ready())).toBe(true); });
  it("does not equate terminal cancellation or receipt arrival with settled accounting", () => {
    for (const index of [0, 1]) { const v = ready(); v.overview.policies[index]!.pendingRunCount = 1; expect(caseCancellationAccountingReady(expected, v)).toBe(false); }
  });
  it("rejects wrong company, run, agent and task identities", () => {
    for (const field of ["companyId", "agentId", "issueId", "id"] as const) { const v = ready(); v.run[field] = "other"; expect(caseCancellationAccountingReady(expected, v)).toBe(false); }
    const v = ready(); v.nativeRun.companyId = "other"; expect(caseCancellationAccountingReady(expected, v)).toBe(false);
  });
  it("never forces readiness from missing scope, legacy run, unfinished run, paused or exhausted budget", () => {
    const variants = [ready(), ready(), ready(), ready(), ready()];
    variants[0]!.overview.policies.pop(); variants[1]!.nativeRun.runtimeMode = "legacy";
    variants[2]!.run.finishedAt = null as unknown as Date; variants[3]!.overview.policies[0]!.paused = true; variants[4]!.overview.policies[0]!.remainingAmount = 0;
    for (const v of variants) expect(caseCancellationAccountingReady(expected, v)).toBe(false);
  });
});
describe("public case assignment permission prerequisite", () => {
  function context(readback = true, companyId = "company") {
    const before = { id: "worker", companyId, permissions: { canCreateAgents: false, canCreateSkills: false, canAssignTasks: false } };
    const api = { get: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce({ ...before, permissions: { ...before.permissions, canAssignTasks: readback } }), patch: vi.fn().mockResolvedValue({}) };
    return { ctx: { input: { api, fixtures: { company: { id: "company" } }, evidence: vi.fn() } } as unknown as ChatCatalogContext, api };
  }
  it("uses dedicated route with required fields preserving unrelated authority", async () => {
    const { ctx, api } = context(); await grantCaseTaskAssignment(ctx, "worker");
    expect(api.patch).toHaveBeenCalledExactlyOnceWith("/api/agents/worker/permissions", { canCreateAgents: false, canCreateSkills: false, canAssignTasks: true }); expect(api.get).toHaveBeenCalledTimes(2);
  });
  it("fails closed on false readback and foreign agent before mutation", async () => {
    const wrong = context(false); await expect(grantCaseTaskAssignment(wrong.ctx, "worker")).rejects.toThrow("readback");
    const foreign = context(true, "other"); await expect(grantCaseTaskAssignment(foreign.ctx, "worker")).rejects.toThrow("scope"); expect(foreign.api.patch).not.toHaveBeenCalled();
  });
});
