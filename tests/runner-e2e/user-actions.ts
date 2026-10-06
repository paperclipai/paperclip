import { expect, type Page } from "@playwright/test";

export async function createTaskThroughUi(input: {
  page: Page;
  issuePrefix: string;
  agentName: string;
  title: string;
  prompt: string;
  workMode: "standard" | "planning" | "ask";
  projectName?: string;
  attachments?: readonly string[];
}) {
  const issuesUrl = `/${encodeURIComponent(input.issuePrefix)}/issues`;
  const newTask = input.page.getByRole("button", { name: /^New task$/i }).first();
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
  const dialog = input.page.getByRole("dialog");
  const titleInput = dialog.getByPlaceholder("Task title");
  const hasTitleInput = await titleInput.count() > 0;
  if (hasTitleInput) await titleInput.fill(input.title);
  await input.page
    .getByRole("dialog")
    .getByRole("textbox", { name: "editable markdown", exact: true })
    .fill(input.prompt);
  if (input.workMode !== "standard") {
    const legacyMode = dialog.locator('[data-issue-work-mode-chip="standard"]');
    if (await legacyMode.count()) {
      await legacyMode.click();
      await input.page.locator(`[data-issue-work-mode="${input.workMode}"]`).click();
    } else {
      await dialog.getByRole("button", { name: "Add to composer", exact: true }).click();
      await input.page.getByRole("menuitem", { name: input.workMode === "planning" ? /^Plan mode/ : /^Ask mode/ }).click();
    }
  }
  await input.page
    .getByRole("button", { name: /^(?:Select )?Assignee$/i })
    .click();
  await input.page
    .getByPlaceholder(/^Search assignees(?:…|\.\.\.)?$/i)
    .fill(input.agentName);
  await input.page.getByText(input.agentName, { exact: true }).last().click();
  if (input.projectName) {
    // Selecting the assignee advances focus to this selector and opens it.
    // Focus is idempotent here; clicking would toggle an already-open popover
    // closed before the search field can be filled.
    const projectTrigger = dialog.getByRole("button", { name: "Project", exact: true })
      .or(dialog.getByRole("button", { name: input.projectName, exact: true }));
    await projectTrigger.focus();
    const projectSearch = input.page.getByPlaceholder(/^Search projects(?:…|\.\.\.)?$/i);
    await expect(projectSearch).toBeVisible({ timeout: 2_000 }).catch(async () => {
      if (await projectTrigger.getAttribute("aria-expanded") !== "true") await projectTrigger.click();
      await expect(projectSearch).toBeVisible();
    });
    await projectSearch.fill(input.projectName);
    await input.page.getByText(input.projectName, { exact: true }).last().click();
  }
  const submittedAtMs = Date.now();
  if (input.attachments?.length) {
    const chooser = input.page.waitForEvent("filechooser");
    const upload = dialog.getByRole("button", { name: "Upload", exact: true });
    if (await upload.count()) await upload.click();
    else {
      await dialog.getByRole("button", { name: "Add to composer", exact: true }).click();
      await input.page.getByRole("menuitem", { name: /^Files and images/ }).click();
    }
    await (await chooser).setFiles([...input.attachments]);
    // Upload finishes as part of task creation; the dialog retains the selected files.
  }
  const created = input.page.waitForResponse(response => response.request().method() === "POST" && /^\/api\/companies\/[^/]+\/issues$/.test(new URL(response.url()).pathname));
  await input.page
    .getByRole("button", { name: /^Create task$/i })
    .click();
  const response = await created;
  if (!response.ok()) throw new Error("Task creation request failed");
  if (!hasTitleInput && input.title) {
    // Prompt-only creation generates a title. Set only fixture naming metadata
    // through the public API; execution and results remain entirely real.
    const issue = await response.json();
    const renamed = await input.page.request.patch(new URL(`/api/issues/${issue.id}`, response.url()).href, { data: { title: input.title } });
    if (!renamed.ok()) throw new Error("Fixture task naming failed");
  }
  // The create response precedes staged-file uploads. The production dialog
  // closes after those uploads finish; navigating earlier can cancel them.
  await expect(dialog).not.toBeVisible({ timeout: 30_000 });
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
