import { expect, test } from "@playwright/test";

test("Unikraft uses the ordinary access and credential wizard", async ({ page, request }) => {
  const response = await request.post("/api/companies", { data: { name: `Unikraft setup ${Date.now()}` } });
  expect(response.ok()).toBe(true);
  const company = await response.json();
  await page.goto(`/${company.issuePrefix}/apps`);
  await expect(page.getByRole("heading", { name: "Connectors", exact: true })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search connectors" }).fill("Unikraft");
  const card = page.getByRole("list", { name: "Connector list" }).getByRole("listitem").filter({ hasText: "Unikraft" });
  await expect(card).toHaveCount(1);
  // App marks are decorative (empty alt), so they have no accessible img role.
  await expect(card.locator('img[src="/brands/apps/unikraft.svg"]')).toBeVisible();
  await card.getByRole("button", { name: "Add key Unikraft", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connect Unikraft", exact: true })).toBeVisible();
  await expect(page.getByLabel("Your Unikraft key", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Your Unikraft key", { exact: true })).toHaveAttribute("type", "password");
  await expect(page.getByText("Default metro", { exact: true })).not.toBeVisible();
  await expect(page.getByText("Connects for everyone in your organization, available to all agents.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Change", exact: true }).click();
  await expect(page.getByText("Which humans can use this credential?", { exact: true })).toBeVisible();
  await expect(page.getByText("Default metro", { exact: true })).toBeVisible();
  await expect(page.locator("select").filter({ has: page.locator('option[value="fra"]') })).toHaveValue("fra");
  // No token is submitted and no real provider connection is created. Gateway
  // lifecycle and provider reads are exercised in the database-backed suite.
});
