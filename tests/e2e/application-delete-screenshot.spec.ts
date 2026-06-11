import { expect, test } from "@playwright/test";

// One-off visual capture for PAP-10817 (application delete confirm dialog).
// Boots the throwaway local_trusted instance via the shared webServer, seeds a
// connection-free application through the board API, then opens the row-actions
// Delete dialog and screenshots it.
test("captures the application delete confirm dialog", async ({ page }) => {
  await page.goto("/dashboard");

  const companyRes = await page.request.post("/api/companies", {
    data: { name: `PAP-10817 delete dialog ${Date.now()}` },
  });
  expect(companyRes.ok(), `create company failed ${companyRes.status()}: ${await companyRes.text()}`).toBe(true);
  const company = await companyRes.json();
  const companyId: string = company.id;
  const prefix: string = company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E";

  const created = await page.request.post(`/api/companies/${companyId}/tools/applications`, {
    data: { name: "Demo Notes", description: "Sample MCP application", type: "mcp_http" },
  });
  // 409 = the application already exists from a prior run (DB persists); that is fine.
  if (!created.ok() && created.status() !== 409) {
    throw new Error(`create failed ${created.status()}: ${await created.text()} (companyId=${companyId})`);
  }

  await page.goto(`/${prefix}/tools/applications`);
  await expect(page.getByText("Demo Notes")).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Actions for Demo Notes" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Delete application" })).toBeVisible();
  await expect(dialog.getByText("No connections are attached")).toBeVisible();

  await dialog.screenshot({ path: "test-results/pap-10817-delete-dialog.png" });

  await page.keyboard.press("Escape");

  // Second capture: the guarded variant. A connection-bearing application warns
  // that delete is blocked, matching the server-side 409 guard.
  const conn = await page.request.post(`/api/companies/${companyId}/tools/connections`, {
    data: {
      applicationName: "Guarded MCP",
      name: "Primary connection",
      transport: "remote_http",
      config: { url: "https://fixture.example/mcp" },
    },
  });
  if (!conn.ok() && conn.status() !== 409) {
    throw new Error(`connection create failed ${conn.status()}: ${await conn.text()}`);
  }

  await page.goto(`/${prefix}/tools/applications`);
  await expect(page.getByText("Guarded MCP")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Actions for Guarded MCP" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();

  const guardedDialog = page.getByRole("dialog");
  await expect(guardedDialog.getByText("delete is blocked while connections exist")).toBeVisible();
  await guardedDialog.screenshot({ path: "test-results/pap-10817-delete-dialog-guarded.png" });

  await page.request.delete(`/api/companies/${companyId}`);
});
