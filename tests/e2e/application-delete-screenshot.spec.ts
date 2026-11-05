import { expect, test } from "@playwright/test";

// One-off visual capture for PAP-10817. Connection removal now lives on the
// Connectors page, rather than behind a per-connection setup surface.
test("captures the current app removal confirmations", async ({ page }) => {
  const companyRes = await page.request.post("/api/companies", {
    data: { name: `PAP-10817 remove app ${Date.now()}` },
  });
  expect(companyRes.ok(), `create company failed ${companyRes.status()}: ${await companyRes.text()}`).toBe(true);
  const company = await companyRes.json();
  const companyId: string = company.id;
  const prefix: string = company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E";

  const conn = await page.request.post(`/api/companies/${companyId}/tools/connections`, {
    data: {
      applicationName: "Guarded MCP",
      name: "Primary connection",
      transport: "mcp_remote",
      config: { url: "http://127.0.0.1:65535/mcp" },
    },
  });
  expect(conn.ok(), `connection create failed ${conn.status()}: ${await conn.text()}`).toBe(true);
  await conn.json();

  await page.goto(`/${prefix}/apps`);
  await expect(page.getByRole("heading", { name: "Connectors" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Manage Primary connection connection" }).click();
  await page.getByRole("menuitem", { name: "Remove connection" }).click();
  await expect(page.getByRole("button", { name: "Remove connection" })).toBeVisible();
  await page.screenshot({ path: "test-results/pap-10817-delete-dialog-guarded.png", fullPage: true });

  await page.request.delete(`/api/companies/${companyId}`).catch(() => undefined);
});
