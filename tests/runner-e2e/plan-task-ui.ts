import { expect, type Page } from "@playwright/test";

/** The current composer creates a task from its description and assigns its
 * title later. Capture the actual public create response; never guess its ID
 * from a title or mutate the issue behind the browser. */
export async function createPlanTaskThroughUi(input: {
  page: Page; companyId: string; issuePrefix: string; agentName: string; prompt: string;
}): Promise<{ id: string }> {
  const { page } = input;
  await page.goto(`/${encodeURIComponent(input.issuePrefix)}/issues`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "New Task", exact: true }).first().click();
  const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "New task", exact: true }) });
  await dialog.getByRole("textbox", { name: "editable markdown", exact: true }).fill(input.prompt);
  const assignee = dialog.getByRole("button", { name: "Select assignee", exact: true });
  await assignee.click();
  await page.getByRole("searchbox", { name: "Search assignees", exact: true }).fill(input.agentName);
  const option = page.getByRole("listbox", { name: "Assignees" }).getByRole("option").filter({ has: page.getByText(input.agentName, { exact: true }) });
  await expect(option).toHaveCount(1);
  await option.click();
  await expect(assignee).toContainText(input.agentName);
  const responsePromise = page.waitForResponse(response => response.request().method() === "POST" &&
    new URL(response.url()).pathname === `/api/companies/${input.companyId}/issues`);
  await dialog.getByRole("button", { name: "Create task", exact: true }).click();
  const response = await responsePromise;
  if (!response.ok()) throw new Error(`Browser task creation failed: ${response.status()}`);
  const issue = await response.json();
  if (typeof issue.id !== "string" || issue.companyId !== input.companyId) throw new Error("Browser created an unexpected issue identity");
  return { id: issue.id };
}
