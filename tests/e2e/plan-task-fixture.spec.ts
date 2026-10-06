import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createPlanTaskThroughUi } from "../runner-e2e/plan-task-ui.js";

test("planning fixture creates the exact assignment through the current composer without providers", async ({ page, request }) => {
  const companyResponse = await request.post("/api/companies", { data: { name: `Planning setup ${randomUUID()}` } });
  expect(companyResponse.ok()).toBe(true);
  const company = await companyResponse.json();
  try {
    let lead: { id: string; name: string } | undefined;
    for (const name of ["A Different Owner", "Planning Fixture Lead"]) {
      const response = await request.post(`/api/companies/${company.id}/agents`, { data: {
        name, role: "general", adapterType: "process", adapterConfig: { command: "false" },
        runtimeConfig: { heartbeat: { enabled: false } },
      } });
      expect(response.ok()).toBe(true);
      const agent = await response.json();
      expect((await request.post(`/api/agents/${agent.id}/pause`)).ok()).toBe(true);
      lead = agent;
    }
    const prompt = "Plan the work briefly, then carry it out. Verify a sample order and save the requested result.";
    const created = await createPlanTaskThroughUi({ page, companyId: company.id, issuePrefix: company.issuePrefix,
      agentName: lead!.name, prompt });
    const issue = await (await request.get(`/api/issues/${created.id}`)).json();
    expect(issue).toMatchObject({ companyId: company.id, assigneeAgentId: lead!.id, description: prompt, workMode: "standard" });
    const runs = await request.get(`/api/companies/${company.id}/heartbeat-runs?limit=100`);
    expect(runs.ok()).toBe(true);
    expect(await runs.json()).toEqual([]);
  } finally {
    expect((await request.delete(`/api/companies/${company.id}`)).ok()).toBe(true);
  }
});
