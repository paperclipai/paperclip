import { test, expect } from "@playwright/test";

test("graph notes and dashboard layouts persist in their workspace", async ({ page }) => {
  const previous = await (await page.request.get("/api/instance/settings/experimental")).json();
  const enabled = await page.request.patch("/api/instance/settings/experimental", {
    data: { enableAgentGraph: true, enableCustomizableDashboard: true },
  });
  expect(enabled.ok()).toBe(true);
  const workspaces: Array<{ id: string; issuePrefix: string }> = [];
  try {
    for (const suffix of ["A", "B"]) {
      const created = await page.request.post("/api/companies", { data: { name: `Visual ${suffix} ${Date.now()}` } });
      expect(created.ok()).toBe(true);
      const workspace = await created.json();
      workspaces.push(workspace);
      const agent = await page.request.post(`/api/companies/${workspace.id}/agents`, { data: {
        setupId: crypto.randomUUID(), name: `Held ${suffix}`, role: "designer", adapterType: "process",
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      } });
      expect(agent.ok()).toBe(true);
    }
    const [a, b] = workspaces;
    await page.goto(`/${a.issuePrefix}/org`);
    await expect(page.getByTestId("agent-graph-node")).toHaveCount(1);
    await page.getByRole("button", { name: "Add note", exact: true }).click();
    await page.getByLabel("Note text").fill("Brief exclusivo do workspace A");
    await page.getByRole("button", { name: "Add note", exact: true }).focus();
    await expect.poll(async () => (await (await page.request.get(`/api/companies/${a.id}/ui-layouts/agent_graph/me`)).json()).layout?.stickies?.[0]?.text)
      .toBe("Brief exclusivo do workspace A");
    await page.reload();
    await expect(page.getByLabel("Note text")).toHaveValue("Brief exclusivo do workspace A");
    await page.goto(`/${b.issuePrefix}/org`);
    await expect(page.getByTestId("agent-graph-node")).toHaveCount(1);
    await expect(page.getByLabel("Note text")).toHaveCount(0);

    await page.goto(`/${a.issuePrefix}/dashboard`);
    const grid = page.getByTestId("dashboard-grid");
    await expect(grid).toBeVisible();
    const before = await grid.getByTestId("dashboard-widget").count();
    await grid.getByRole("button", { name: "Customize", exact: true }).click();
    await grid.getByRole("button", { name: "Add widget", exact: true }).click();
    await page.getByRole("button", { name: "Add Agents Enabled", exact: true }).click();
    await page.keyboard.press("Escape");
    await grid.getByRole("button", { name: "Done", exact: true }).click();
    await expect(grid.getByTestId("dashboard-widget")).toHaveCount(before + 1);
    await expect.poll(async () => (await (await page.request.get(`/api/companies/${a.id}/ui-layouts/dashboard/me`)).json()).layout?.widgets?.length)
      .toBe(before + 1);
    await page.reload();
    await expect(page.getByTestId("dashboard-grid").getByTestId("dashboard-widget")).toHaveCount(before + 1);
    expect((await (await page.request.get(`/api/companies/${b.id}/ui-layouts/dashboard/me`)).json()).layout).toBeNull();
  } finally {
    await page.request.patch("/api/instance/settings/experimental", { data: {
      enableAgentGraph: previous.enableAgentGraph === true,
      enableCustomizableDashboard: previous.enableCustomizableDashboard === true,
    } });
    for (const workspace of workspaces) await page.request.patch(`/api/companies/${workspace.id}`, { data: { status: "archived" } });
  }
});
