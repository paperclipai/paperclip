import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerApi } from "./api.js";
import { runnerMatrix } from "./catalog.js";
import { setupLiveFixtures } from "./live-fixtures.js";

const optIn = "PAPERCLIP_CURSOR_CLOUD_ALLOW_UNPRICED_QUALIFICATION";
const execution = runnerMatrix.find(cell => cell.id === "cursor-cloud.runner-cursor-cloud.local.cloud-followup")!;
const companyId = "fixture-company", agentId = "fixture-agent";
const policyDefaults = { companyId, metric: "billed_cents", windowKind: "calendar_month_utc",
  amount: 1_000, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" };
function fixtureApi(changeOverview?: (overview: Record<string, any>) => unknown) {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const policies: Array<Record<string, any>> = [];
  const api = {
    async get(path: string) {
      calls.push({ method: "GET", path });
      if (path.endsWith("/environments?driver=local")) return [{ id: "local", driver: "local" }];
      if (path.endsWith("/budgets/overview")) {
        const overview = { companyId, policies };
        return changeOverview ? changeOverview(overview) : overview;
      }
      throw new Error(`Unexpected GET ${path}`);
    },
    async postSensitive(path: string) { calls.push({ method: "SECRET", path }); return { id: "fixture-secret" }; },
    async post(path: string, body: Record<string, any>) {
      calls.push({ method: "POST", path, body });
      if (path === "/api/companies") return { id: companyId, name: "Test" };
      if (path.endsWith("/agents")) return { ...body, id: agentId, companyId };
      if (path.endsWith("/budgets/policies")) {
        const policy = { ...policyDefaults, ...body, unpricedEventCount: 1, excludedDiagnostic: "not-evidence" };
        policies.push(policy);
        return policy;
      }
      throw new Error(`Unexpected POST ${path}`);
    },
  } as unknown as RunnerApi;
  return { api, calls };
}
function setup(api: RunnerApi, selected = execution) {
  return setupLiveFixtures({ api, execution: selected, executionNonce: "budget-control", workspacePath: "/tmp/cursor-budget-control",
    credentials: { [selected.profile.credential]: "synthetic-provider-key" } });
}
afterEach(() => vi.unstubAllEnvs());

describe("Cursor Cloud qualification budgets", () => {
  it.each([undefined, "", "0", "true"])("blocks missing exact opt-in %s before fixture or provider dispatch", async value => {
    vi.stubEnv(optIn, value);
    const { api, calls } = fixtureApi();
    await expect(setup(api)).rejects.toThrow(optIn);
    expect(calls).toEqual([]);
  });

  it("verifies only the owned company and agent policies with known-cost hard stops intact", async () => {
    vi.stubEnv(optIn, "1");
    const { api, calls } = fixtureApi();
    const fixtures = await setup(api);
    expect(calls.find(call => call.path === "/api/companies")!.body.budgetMonthlyCents).toBe(1_000);
    expect(calls.find(call => call.path.endsWith("/agents"))!.body.budgetMonthlyCents).toBe(1_000);
    const writes = calls.filter(call => call.path.endsWith("/budgets/policies"));
    expect(writes.map(call => ({ path: call.path, body: call.body }))).toEqual([
      { path: `/api/companies/${companyId}/budgets/policies`, body: { scopeType: "company", scopeId: companyId,
        metric: "billed_cents", windowKind: "calendar_month_utc", amount: 1_000, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" } },
      { path: `/api/companies/${companyId}/budgets/policies`, body: { scopeType: "agent", scopeId: agentId,
        metric: "billed_cents", windowKind: "calendar_month_utc", amount: 1_000, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" } },
    ]);
    expect(calls.at(-1)).toEqual({ method: "GET", path: `/api/companies/${companyId}/budgets/overview` });
    expect((fixtures as unknown as Record<string, unknown>).qualificationBudget).toEqual({
      schema: "paperclip.e2e.cursor-cloud.qualification-budget.v1", unpricedUsageOptIn: true,
      policies: [{ ...policyDefaults, scopeType: "company", scopeId: companyId }, { ...policyDefaults, scopeType: "agent", scopeId: agentId }],
    });
    await fixtures.teardown();
  });

  it.each([
    ["missing agent", (value: any) => { value.policies.pop(); }],
    ["foreign scope", (value: any) => { value.policies[1].scopeId = "foreign-agent"; }],
    ["foreign company", (value: any) => { value.policies[1].companyId = "foreign-company"; }],
    ["foreign overview", (value: any) => { value.companyId = "foreign-company"; }],
    ["zero limit", (value: any) => { value.policies[0].amount = 0; }],
    ["hard stop disabled", (value: any) => { value.policies[1].hardStopEnabled = false; }],
    ["inactive guard", (value: any) => { value.policies[0].isActive = false; }],
    ["unpriced block", (value: any) => { value.policies[1].unpricedUsagePolicy = "block"; }],
    ["wrong metric", (value: any) => { value.policies[0].metric = "runs"; }],
    ["wrong window", (value: any) => { value.policies[1].windowKind = "rolling_day"; }],
    ["duplicate scope", (value: any) => { value.policies.push({ ...value.policies[1] }); }],
    ["malformed policies", (value: any) => { value.policies = null; }],
  ] as const)("fails closed before returning a dispatchable fixture: %s", async (_name, change) => {
    vi.stubEnv(optIn, "1");
    const { api, calls } = fixtureApi(value => { change(value); return value; });
    await expect(setup(api)).rejects.toThrow("budget policy readback");
    expect(calls.some(call => call.path.includes("/issues"))).toBe(false);
  });

  it("propagates failed public policy readback before dispatch", async () => {
    vi.stubEnv(optIn, "1");
    const { api } = fixtureApi(() => { throw new Error("readback transport failed"); });
    await expect(setup(api)).rejects.toThrow("readback transport failed");
  });

  it("does not change other providers or require their unpriced opt-in", async () => {
    vi.stubEnv(optIn, undefined);
    const { api, calls } = fixtureApi();
    const other = runnerMatrix.find(cell => cell.suite.id === "stock-harness" && cell.profile.id === "runner-codex" && cell.environment.id === "local")!;
    const fixtures = await setup(api, other);
    expect(calls.some(call => call.path.includes("/budgets/"))).toBe(false);
    expect(fixtures).not.toHaveProperty("qualificationBudget");
    await fixtures.teardown();
  });
});
