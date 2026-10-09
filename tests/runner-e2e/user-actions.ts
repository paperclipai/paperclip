import { expect, type Locator, type Page } from "@playwright/test";

/** Rich editors interpret pasted Markdown; fill inserts literal paragraph text. */
export async function fillTaskPrompt(editor: Locator, prompt: string): Promise<void> {
  if (!/^ {0,3}(?:`{3,}|~{3,})/m.test(prompt)
    || await editor.evaluate(element => element.tagName === "TEXTAREA")) {
    await editor.fill(prompt);
    return;
  }
  await editor.fill("");
  await editor.focus();
  await editor.evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    const event = new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    if (!event.defaultPrevented) throw new Error("Task editor did not accept the Markdown paste");
  }, prompt);
}

export async function createTaskThroughUi(input: {
  page: Page;
  issuePrefix: string;
  agentName: string;
  title: string;
  prompt: string;
  workMode: "standard" | "planning" | "ask";
  projectName?: string;
  requireExplicitTitle?: boolean;
  attachments?: readonly string[];
}) {
  // Search's public creation action exposes the explicit title field. Strict
  // native-operation fixtures use it so automatic task naming is not an extra
  // provider mutation before the operation whose permission is under test.
  const issuesUrl = input.requireExplicitTitle
    ? `/${encodeURIComponent(input.issuePrefix)}/search?scope=issues&q=${encodeURIComponent(`"${input.title}"`)}`
    : `/${encodeURIComponent(input.issuePrefix)}/issues`;
  const newTask = input.requireExplicitTitle
    ? input.page.getByRole("button", { name: "Create task from this query", exact: true })
    : input.page.getByRole("button", { name: /^New task$/i }).first();
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
  const dialog = input.page.getByRole("dialog", { name: "New task", exact: true });
  const titleInput = dialog.getByRole("textbox", { name: "Task title", exact: true });
  if (await titleInput.isVisible()) await titleInput.fill(input.title);
  else if (input.requireExplicitTitle) throw new Error("This title-preservation case requires a visible explicit title input");
  await fillTaskPrompt(dialog.getByRole("textbox", { name: "editable markdown", exact: true }), input.prompt);
  if (input.workMode !== "standard") {
    await dialog.getByRole("button", { name: "Add to composer", exact: true }).click();
    await input.page.getByTestId(input.workMode === "planning" ? "composer-add-plan" : "composer-add-ask").click();
  }
  await dialog
    .getByRole("button", { name: "Select assignee", exact: true })
    .click();
  await input.page.getByRole("searchbox", { name: "Search assignees", exact: true }).fill(input.agentName);
  await input.page.getByRole("option").filter({ has: input.page.getByText(input.agentName, { exact: true }) }).click();
  await expect(input.page.getByRole("searchbox", { name: "Search assignees", exact: true })).toBeHidden();
  if (input.projectName) {
    // Selecting the assignee advances focus to this selector and opens it.
    // Focus is idempotent here; clicking would toggle an already-open popover
    // closed before the search field can be filled.
    const projectTrigger = dialog.getByRole("group", { name: "Task project and worktrees", exact: true }).getByRole("button").first();
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
  // The prompt-only composer generates a provisional title which the provider
  // can rename immediately. Bind the fixture to the actual creation response.
  const [response] = await Promise.all([
    input.page.waitForResponse(response => response.request().method() === "POST"
      && /^\/api\/companies\/[^/]+\/issues$/.test(new URL(response.url()).pathname)),
    dialog.getByRole("button", { name: "Create task", exact: true }).click(),
  ]);
  expect(response.status()).toBe(201);
  const issue = await response.json() as { id: string; companyId: string; title: string; titleNeedsGeneration: boolean };
  expect(new URL(response.url()).pathname).toBe(`/api/companies/${issue.companyId}/issues`);
  expect(issue.id).toEqual(expect.any(String));
  expect(issue.id.length).toBeGreaterThan(0);
  if (input.requireExplicitTitle) {
    expect(issue.title).toBe(input.title);
    expect(issue.titleNeedsGeneration).toBe(false);
  }
  // Creation precedes uploads; allow them to finish before navigation.
  await expect(dialog).not.toBeVisible({ timeout: 30_000 });
  return { submittedAtMs, issueId: issue.id };
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
