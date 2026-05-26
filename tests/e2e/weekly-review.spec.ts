import { expect, test } from "@playwright/test";

test("CEO can generate the Northstar Weekly Review and record a recommendation decision", async ({ page }) => {
  const seedRes = await page.request.post("/api/weekly-review-fixtures/northstar");
  expect(seedRes.ok()).toBe(true);
  const seed = await seedRes.json();

  await page.addInitScript((companyId: string) => {
    window.localStorage.setItem("paperclip.selectedCompanyId", companyId);
  }, seed.company.id);

  await page.goto(`/${seed.company.issuePrefix}/weekly-review`);
  await expect(page.getByRole("heading", { name: "Weekly Review" })).toBeVisible();
  await expect(page.getByText(seed.company.name)).toBeVisible();

  await page.getByRole("button", { name: "Generate" }).click();

  await expect(page.getByText("Ready").first()).toBeVisible();
  await expect(page.getByText("Open findings")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Evidence gaps" })).toBeVisible();

  for (const stableId of ["NSR-F01", "NSR-F02", "NSR-F03", "NSR-F04", "NSR-F05", "NSR-F06", "NSR-F07", "NSR-F08"]) {
    await expect(page.getByText(stableId)).toBeVisible();
  }

  await expect(page.getByText("claude_local").first()).toBeVisible();
  await expect(page.getByText("codex_local").first()).toBeVisible();
  await expect(page.getByText("agy_local").first()).toBeVisible();
  await expect(page.getByText("gemini-3.5-flash").first()).toBeVisible();

  await page.getByRole("button", { name: "Accept" }).first().click();

  await expect(page.getByText("Latest action: accept recommendation (completed)")).toBeVisible();
  await expect(page.getByText("accept recommendation").first()).toBeVisible();
});
