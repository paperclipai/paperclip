import { expect, type Page } from "@playwright/test";
import { JourneyError } from "./types.js";

type BrowserStage = "project_list" | "project_open" | "project_task_open" | "project_property";
async function browserStep<T>(stage: BrowserStage, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof JourneyError) throw error;
    // Playwright errors can contain page content. Retain only the closed stage.
    throw new JourneyError("failed", `project_context_${stage}_failed`);
  }
}

export async function reopenProjectThroughList(input: { page: Page; origin: string; issuePrefix: string; projectName: string; projectRef: string }) {
  const { page, origin, issuePrefix, projectName, projectRef } = input;
  await browserStep("project_list", () => page.goto(`${origin}/${issuePrefix}/projects`));
  await browserStep("project_open", async () => {
    const link = page.locator("main#main-content").getByRole("link").filter({ hasText: projectName });
    await expect(link).toHaveCount(1);
    await link.click();
    const expected = `${origin}/${issuePrefix}/projects/${encodeURIComponent(projectRef)}/issues`;
    await expect.poll(() => { const url = new URL(page.url()); return `${url.origin}${url.pathname}`; }).toBe(expected);
    await page.reload();
    await expect(page.locator("main#main-content").getByRole("heading", { name: projectName, exact: true })).toBeVisible();
  });
}

export async function openProjectTaskThroughList(input: { page: Page; origin: string; issuePrefix: string; projectName: string; taskTitle: string; taskRef: string; prompt: string }) {
  const { page, origin, issuePrefix, projectName, taskTitle, taskRef, prompt } = input;
  await browserStep("project_task_open", async () => {
    const link = page.locator("main#main-content").getByRole("link").filter({ hasText: taskTitle });
    await expect(link).toHaveCount(1);
    await link.click();
    const expected = `${origin}/${issuePrefix}/issues/${encodeURIComponent(taskRef)}`;
    await expect.poll(() => { const url = new URL(page.url()); return `${url.origin}${url.pathname}`; }).toBe(expected);
    await page.reload();
    const main = page.locator("main#main-content");
    await expect(main.getByText(taskTitle, { exact: true }).filter({ visible: true }).first()).toBeVisible();
    await expect(main.getByText(prompt, { exact: true }).filter({ visible: true }).first()).toBeVisible();
  });
  await browserStep("project_property", async () => {
    const properties = page.getByRole("button", { name: /^(Show properties|Properties)$/ }).filter({ visible: true }).first();
    if (await properties.isVisible()) await properties.click();
    const projectProperty = page.locator("[data-property-row]").filter({ has: page.locator('[data-property-label="Project"]') }).filter({ visible: true });
    await expect(projectProperty).toHaveCount(1);
    await expect(projectProperty.locator("[data-property-value]")).toContainText(projectName);
  });
}
