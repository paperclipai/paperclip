import { expect, type Page } from "@playwright/test";

export async function createMarketingWorkspace(page: Page, name: string) {
  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: "Criar workspace", exact: true })).toBeVisible();
  await page.getByLabel("Nome do workspace", { exact: true }).fill(name);
  const saved = page.waitForResponse(response => response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/companies");
  await page.getByRole("button", { name: "Criar workspace", exact: true }).click();
  const response = await saved;
  expect(response.ok()).toBe(true);
  const workspace = await response.json();
  await expect(page.getByRole("heading", { name: "Crie seu agente de marketing" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/${workspace.issuePrefix}/agents/new`));
  return workspace as { id: string; issuePrefix: string; name: string };
}

export async function chooseMarketingType(page: Page, label = "CMO") {
  await page.getByLabel("Tipo de agente", { exact: true }).click();
  await page.getByRole("option", { name: label, exact: true }).click();
}
