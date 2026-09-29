import { expect, test } from "@playwright/test";

// Uses the normal throwaway E2E instance. This checks the local setup entry,
// not account consent or a live Railway deployment.
test("Railway is discoverable and opens its OAuth setup", async ({ page, request }) => {
  test.setTimeout(120000);
  const response = await request.post("/api/companies", { data: { name: `Railway catalog QA ${Date.now()}` } });
  expect(response.ok()).toBe(true);
  const company = await response.json();
  await page.goto(`/${company.issuePrefix}/apps`, { waitUntil: "domcontentloaded" });
  const card = page.getByRole("list", { name: "Connector list" }).getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Railway", exact: true }) });
  await expect(card).toBeVisible({ timeout: 30000 });
  await card.getByRole("button", { name: /Connect/ }).click();
  await expect(page).toHaveURL(/\/apps\/connect\?/, { timeout: 20000 });
  await expect(page.getByRole("heading", { name: /Railway/ }).first()).toBeVisible();
  await expect(page.getByText(/Project tokens are not supported/)).toBeVisible();
  await expect(page.getByText(/Live Railway qualification is pending/)).toBeVisible();
  await page.screenshot({ path: "tests/e2e/test-results/railway-oauth-setup.png", fullPage: true });
});
