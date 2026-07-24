import { expect, test } from "@playwright/test";

// One-off visual capture for PAP-10817. The retired Tools -> Applications
// table now redirects into Apps, so capture the current app removal
// confirmation on the app Advanced tab instead.
test("captures the current app removal confirmations", async ({ page }) => {
  const flags = await page.request.patch("/api/instance/settings/experimental", { data: { enableApps: true } });
  expect(flags.ok(), `enable apps failed ${flags.status()}: ${await flags.text()}`).toBe(true);

  const companyRes = await page.request.post("/api/companies", {
    data: { name: `PAP-10817 remove app ${Date.now()}` },
  });
  expect(companyRes.ok(), `create company failed ${companyRes.status()}: ${await companyRes.text()}`).toBe(true);
  const company = await companyRes.json();
  const companyId: string = company.id;
  const prefix: string = company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E";

  const created = await page.request.post(`/api/companies/${companyId}/tools/applications`, {
    data: { name: "Demo Notes", description: "Sample MCP application", type: "mcp_http" },
  });
  expect(created.ok(), `create failed ${created.status()}: ${await created.text()}`).toBe(true);
  const application = await created.json();

  await page.goto(`/${prefix}/apps/app/${application.id}/advanced`);
  await expect(page.getByRole("heading", { name: "Demo Notes" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Danger zone")).toBeVisible();
  await page.getByRole("button", { name: "Remove app", exact: true }).click();
  await expect(page.getByRole("button", { name: "Yes, remove it" })).toBeVisible();
  await page.screenshot({ path: "test-results/pap-10817-delete-dialog.png", fullPage: true });

  const conn = await page.request.post(`/api/companies/${companyId}/tools/connections`, {
    data: {
      applicationName: "Guarded MCP",
      name: "Primary connection",
      transport: "mcp_remote",
      config: { url: "https://fixture.example/mcp" },
    },
  });
  expect(conn.ok(), `connection create failed ${conn.status()}: ${await conn.text()}`).toBe(true);
  const connection = await conn.json();

  await page.goto(`/${prefix}/apps/${connection.id}/advanced`);
  await expect(page.getByRole("heading", { name: "Primary connection" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Remove app", exact: true }).click();
  await expect(page.getByRole("button", { name: "Yes, remove it" })).toBeVisible();
  await page.screenshot({ path: "test-results/pap-10817-delete-dialog-guarded.png", fullPage: true });

  await page.request.delete(`/api/companies/${companyId}`).catch(() => undefined);
});
