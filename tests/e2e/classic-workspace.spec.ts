import { expect, test } from "@playwright/test";
import { json, setup } from "./agent-chat.shared";

test("expanding an already visible plan briefly highlights it and preserves keyboard focus", async ({ page, request }) => {
  const company = await json(await request.post("/api/companies", { data: { name: "Plan focus" } }));
  const preference = await json(await request.get("/api/workspace-preferences/me"));
  const preferenceUrl = `/api/companies/${company.id}/workspace-preferences/me`;
  try {
    await json(await request.put(preferenceUrl, { data: { coordinatorWorkspaceEnabled: false } }));
    const issue = await json(await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: "Review the launch", status: "backlog" },
    }));
    await json(await request.put(`/api/issues/${issue.id}/documents/plan`, {
      data: { title: "Launch plan", body: "# Launch plan\n\nReview the checklist.", format: "markdown" },
    }));
    await json(await request.put(`/api/issues/${issue.id}/documents/notes`, {
      data: { title: "Launch notes", body: "Record the decisions.", format: "markdown" },
    }));
    await page.setViewportSize({ width: 1440, height: 900 });
    const taskUrl = `/${company.issuePrefix}/issues/${issue.identifier}`;
    await page.goto(taskUrl);
    const card = page.getByRole("link", { name: "Open Plan revision 1", exact: true });
    const pane = page.getByRole("tabpanel", { name: "Launch plan", exact: true });
    await expect(pane.getByText("Review the checklist.")).toBeVisible();
    await card.click();
    await expect(pane).toBeFocused();
    await page.getByRole("tab", { name: "Properties", exact: true }).click();
    await card.click();
    await expect(pane.getByText("Review the checklist.")).toBeVisible();
    await expect(pane).not.toBeFocused();
    await card.click();
    await expect(pane).toBeFocused();
    await expect(pane).toHaveCSS("animation-name", "plan-pane-attention");
    await pane.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)).then(() => undefined));
    await expect(pane).toHaveCSS("outline-color", /(?:, 0| \/ 0)\)$/);
    await expect(pane).toBeFocused();
    await card.press("Enter");
    await expect(pane).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(pane.getByRole("button", { name: "Open comments on plan" })).toBeFocused();
    await card.press("Enter");
    await expect(pane).toBeFocused();
    await page.goto(`${taskUrl}#document-notes`);
    const notes = page.getByRole("tabpanel", { name: "Launch notes", exact: true });
    await expect(notes.getByText("Record the decisions.")).toBeVisible();
    await expect(notes).not.toBeFocused();
  } finally {
    await json(await request.put(preferenceUrl, { data: { coordinatorWorkspaceEnabled: preference.coordinatorWorkspaceEnabled } }));
    await request.delete(`/api/companies/${company.id}`);
  }
});

test("Coordinator is standard and Classic is an explicit personal experiment", async ({ page, request }) => {
  const original = await json(await request.get("/api/workspace-preferences/me"));
  const f = await setup(request);
  const settingsUrl = `/${f.company.issuePrefix}/company/settings/instance/experimental`;
  const preferencePath = `/api/companies/${f.company.id}/workspace-preferences/me`;
  try {
    expect(original.coordinatorWorkspaceEnabled).toBe(true);
    await page.goto(f.route);
    await expect(page.getByRole("navigation", { name: "Workspace navigation" })).toBeVisible();
    await page.goto(settingsUrl);
    const classic = page.getByRole("switch", { name: "Enable classic workspace", exact: true });
    await expect(classic).toBeEnabled();
    await expect(classic).not.toBeChecked();
    await expect(page.getByRole("switch", { name: "Enable coordinator workspace", exact: true })).toHaveCount(0);

    await classic.click();
    await expect(classic).toBeChecked();
    await expect.poll(async () => (await json(await request.get("/api/workspace-preferences/me"))).coordinatorWorkspaceEnabled).toBe(false);
    await page.goto(f.route);
    await expect(page.getByRole("navigation", { name: "Workspace navigation" })).toHaveCount(0);
    await page.goto(settingsUrl);
    await page.reload();
    await expect(classic).toBeChecked();

    await classic.click();
    await expect(classic).not.toBeChecked();
    await page.goto(f.route);
    await expect(page.getByRole("navigation", { name: "Workspace navigation" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("navigation", { name: "Workspace navigation" })).toBeVisible();
    await page.goto(settingsUrl);
    await expect(classic).not.toBeChecked();
  } finally {
    await request.put(preferencePath, { data: { coordinatorWorkspaceEnabled: original.coordinatorWorkspaceEnabled } });
    await f.restore();
  }
});
