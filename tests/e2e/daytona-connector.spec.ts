import { expect, test } from "@playwright/test";

test("Daytona uses the ordinary access and credential wizard", async ({ page, request }) => {
  const response = await request.post("/api/companies", { data: { name: `Daytona setup ${Date.now()}` } });
  expect(response.ok()).toBe(true);
  const company = await response.json();
  await page.goto(`/${company.issuePrefix}/apps`);
  await expect(page.getByRole("heading", { name: "Connectors", exact: true })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search connectors" }).fill("Daytona");
  const card = page.getByRole("list", { name: "Connector list" }).getByRole("listitem").filter({ hasText: "Daytona" });
  await expect(card).toHaveCount(1);
  // App marks are decorative (empty alt), so they have no accessible img role.
  await expect(card.locator('img[src="/brands/apps/daytona.svg"]')).toBeVisible();
  await card.getByRole("button", { name: "Add key Daytona", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connect Daytona", exact: true })).toBeVisible();
  await expect(page.getByLabel("Your Daytona key", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Your Daytona key", { exact: true })).toHaveAttribute("type", "password");
  await expect(page.getByLabel("Pin to organization ID", { exact: true })).not.toBeVisible();
  await expect(page.getByText("Connects for everyone in your organization, available to all agents.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Change", exact: true }).click();
  await expect(page.getByText("Which humans can use this credential?", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Pin to organization ID", { exact: true })).toBeVisible();
  // No key is submitted and no real provider connection is created. Gateway
  // lifecycle and provider reads are exercised in the database-backed suite.
});
