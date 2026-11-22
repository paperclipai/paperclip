import { expect, test } from "@playwright/test";
import { json, setup } from "./agent-chat.shared";

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
