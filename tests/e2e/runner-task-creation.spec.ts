import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTaskThroughUi } from "../runner-e2e/user-actions.js";

for (const workMode of ["standard", "planning", "ask"] as const) {
  test(`runner fixture creates a prompt-only ${workMode} task without starting a provider`, async ({ page, request }) => {
    const companyResponse = await request.post("/api/companies", { data: { name: `Runner composer ${randomUUID()}` } });
    expect(companyResponse.ok()).toBe(true);
    const company = await companyResponse.json();
    const agentResponse = await request.post(`/api/companies/${company.id}/agents`, { data: {
      name: "Paused composer fixture", role: "engineer", adapterType: "codex_local",
      runtimeConfig: { heartbeat: { enabled: false } },
    } });
    expect(agentResponse.ok()).toBe(true);
    const agent = await agentResponse.json();
    expect((await request.post(`/api/agents/${agent.id}/pause`)).ok()).toBe(true);
    const projectResponse = await request.post(`/api/companies/${company.id}/projects`, { data: { name: "Composer project" } });
    expect(projectResponse.ok()).toBe(true);
    const project = await projectResponse.json();
    const nextProjectResponse = await request.post(`/api/companies/${company.id}/projects`, { data: { name: "Next composer project" } });
    expect(nextProjectResponse.ok()).toBe(true);
    const nextProject = await nextProjectResponse.json();
    const createdIds = new Set<string>();
    // Reopen with a remembered project, then change that remembered selection.
    for (const selectedProject of [project, project, nextProject]) {
      const prompt = `Preserve this exact prompt for ${workMode} task ${createdIds.size + 1}.`;
      const created = await createTaskThroughUi({ page, issuePrefix: company.issuePrefix, agentName: agent.name,
        title: "Fixture label distinct from the generated title", prompt, workMode, projectName: selectedProject.name });
      const issue = await (await request.get(`/api/issues/${created.issueId}`)).json();
      expect(issue).toMatchObject({ id: created.issueId, companyId: company.id, assigneeAgentId: agent.id,
        projectId: selectedProject.id, description: prompt, workMode });
      expect(issue.title).not.toBe("Fixture label distinct from the generated title");
      expect(created.submittedAtMs).toBeGreaterThan(0);
      expect(createdIds.has(created.issueId)).toBe(false);
      createdIds.add(created.issueId);
    }
    const title = `Explicit native fixture ${randomUUID()}`;
    const explicit = await createTaskThroughUi({ page, issuePrefix: company.issuePrefix, agentName: agent.name,
      title, prompt: "Keep the supplied title and exact prompt.", workMode, projectName: project.name, requireExplicitTitle: true });
    const explicitIssue = await (await request.get(`/api/issues/${explicit.issueId}`)).json();
    expect(explicitIssue).toMatchObject({ title, titleNeedsGeneration: false, projectId: project.id,
      assigneeAgentId: agent.id, description: "Keep the supplied title and exact prompt.", workMode });
    expect(await (await request.get(`/api/companies/${company.id}/heartbeat-runs`)).json()).toEqual([]);
  });
}
