import { expect, type Page } from "@playwright/test";

export async function createTaskThroughUi(input: {
  page: Page;
  issuePrefix: string;
  agentName: string;
  title: string;
  prompt: string;
  workMode: "standard" | "planning" | "ask";
  projectName?: string;
}) {
  const issuesUrl = `/${encodeURIComponent(input.issuePrefix)}/issues`;
  const newTask = input.page.getByRole("button", { name: "New Task" }).first();
  let bootstrapError: unknown;
  for (let bootstrapAttempt = 1; bootstrapAttempt <= 3; bootstrapAttempt += 1) {
    try {
      await input.page.goto(issuesUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await newTask.waitFor({ state: "visible", timeout: 20_000 });
      bootstrapError = undefined;
      break;
    } catch (error) {
      bootstrapError = error;
      if (bootstrapAttempt < 3) await input.page.waitForTimeout(1_000);
    }
  }
  if (bootstrapError) {
    throw new Error(
      `Browser bootstrap failed before task creation: ${bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError)}`,
      { cause: bootstrapError },
    );
  }
  await newTask.click();
  await input.page.getByPlaceholder("Task title").fill(input.title);
  await input.page
    .getByRole("dialog")
    .getByRole("textbox", { name: "editable markdown", exact: true })
    .fill(input.prompt);
  if (input.workMode !== "standard") {
    await input.page
      .getByRole("dialog")
      .locator(`[data-issue-work-mode-chip="standard"]`)
      .click();
    await input.page
      .locator(`[data-issue-work-mode="${input.workMode}"]`)
      .click();
  }
  await input.page
    .getByRole("button", { name: "Assignee", exact: true })
    .click();
  await input.page
    .getByPlaceholder("Search assignees...")
    .fill(input.agentName);
  await input.page.getByText(input.agentName, { exact: true }).last().click();
  if (input.projectName) {
    const dialog = input.page.getByRole("dialog");
    // Selecting the assignee advances focus to this selector and opens it.
    // Focus is idempotent here; clicking would toggle an already-open popover
    // closed before the search field can be filled.
    await dialog.getByRole("button", { name: "Project", exact: true }).focus();
    await dialog.getByPlaceholder("Search projects...").fill(input.projectName);
    await dialog.getByText(input.projectName, { exact: true }).last().click();
  }
  const submittedAtMs = Date.now();
  await input.page
    .getByRole("button", { name: "Create Task", exact: true })
    .click();
  return submittedAtMs;
}

export async function submitTaskReply(
  page: Page,
  body: string,
): Promise<number> {
  const composer = page.getByTestId("task-chat-composer-input").last();
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer
    .locator('[contenteditable="true"], textarea')
    .first()
    .fill(body);
  const submittedAtMs = Date.now();
  await page.getByTestId("task-chat-composer-send").last().click();
  return submittedAtMs;
}
