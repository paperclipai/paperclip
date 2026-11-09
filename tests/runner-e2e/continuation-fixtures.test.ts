import { expect, it, vi } from "vitest";
import type { RunnerApi } from "./api.js";
import { prepareLegacyContinuationSkill, prepareContinuationBudget } from "./continuation-fixtures.js";
it("initializes the production library and assigns the operational skill before execution", async () => {
  const post = vi.fn();
  const get = vi.fn(async () => [{ key: "paperclipai/paperclip/paperclip" }]);
  await prepareLegacyContinuationSkill({ get, post } as unknown as RunnerApi, "company", "agent");
  expect(get).toHaveBeenCalledWith("/api/companies/company/skills");
  expect(post).toHaveBeenCalledWith("/api/agents/agent/skills/sync?companyId=company", { desiredSkills: ["paperclipai/paperclip/paperclip"], mode: "add" });
  get.mockResolvedValue([]);
  await expect(prepareLegacyContinuationSkill({ get, post } as unknown as RunnerApi, "company", "agent")).rejects.toThrow("missing the bundled");
  expect(post).toHaveBeenCalledTimes(1);
});

it("persists and reads both continuation budget hard stops before returning", async () => {
  const calls: string[] = [];
  const api = { patch: vi.fn(async (url: string) => { calls.push(`patch:${url}`); }),
    get: vi.fn(async (url: string) => { calls.push(`get:${url}`); return { budgetMonthlyCents: 1_000 }; }) };
  await expect(prepareContinuationBudget(api as unknown as RunnerApi, "company", "agent"))
    .resolves.toEqual({ companyMonthlyCents: 1_000, agentMonthlyCents: 1_000 });
  expect(calls).toEqual(["patch:/api/companies/company/budgets", "patch:/api/agents/agent/budgets",
    "get:/api/companies/company", "get:/api/agents/agent"]);
});
it.each(["company", "agent"])("rejects a missing %s budget instead of starting paid work", async target => {
  const api = { patch: vi.fn(), get: vi.fn(async (url: string) =>
    ({ budgetMonthlyCents: url.endsWith(target) ? 0 : 1_000 })) };
  await expect(prepareContinuationBudget(api as unknown as RunnerApi, "company", "agent"))
    .rejects.toThrow("hard stops were not persisted");
});
