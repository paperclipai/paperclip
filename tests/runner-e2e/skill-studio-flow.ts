import { expect, type Page } from "@playwright/test";

type StudioStep = "open_card" | "read_preview" | "open_studio" | "load_file" | "edit_file"
  | "save_file" | "verify_saved" | "reload_file" | "return_task" | "reopen_card";

class SkillStudioFlowError extends Error {
  readonly outcome = "failed";
  readonly code: string;
  constructor(step: StudioStep) {
    const code = `skill_studio_${step}_failed`;
    super(code);
    this.code = code;
  }
}

/** Shared browser story for classic and Cloud: activity card -> Studio -> saved task readback. */
export async function editCreatedSkillThroughStudio(input: {
  page: Page; skillId: string; skillName: string; marker: string; deadlineAt: number;
  read(): Promise<unknown>;
}) {
  let step: StudioStep = "open_card";
  try {
    const { page, skillName } = input;
    const card = page.getByRole("article", { name: `Skill created: ${skillName}`, exact: true });
    await expect(card).toHaveCount(1);
    await expect(card).toBeVisible();
    await card.getByRole("button").click();
    step = "read_preview";
    await expect(page.getByRole("heading", { name: skillName, exact: true })).toBeVisible();
    await expect(page.getByText("Verify checks.", { exact: true })).toBeVisible();
    step = "open_studio";
    await page.getByRole("button", { name: "Open in Skill Studio", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/skills/studio/${input.skillId}$`));
    await expect(page.getByRole("combobox").filter({ hasText: skillName })).toBeVisible();
    const editor = page.getByRole("textbox", { name: "editable markdown", exact: true });
    // Studio mounts the editor before its file query completes. Wait for the
    // saved body, otherwise hydration can replace edits made to the empty draft.
    step = "load_file";
    await expect(editor).toContainText("Verify checks.");
    step = "edit_file";
    await editor.click();
    await editor.press("ControlOrMeta+End");
    await editor.press("Enter");
    await editor.press("Enter");
    await editor.pressSequentially(input.marker);
    step = "save_file";
    await page.getByRole("button", { name: /^Save$/ }).click();
    step = "verify_saved";
    await expect.poll(async () => JSON.stringify(await input.read()).includes(input.marker),
      { timeout: Math.max(1, Math.min(30_000, input.deadlineAt - Date.now())) }).toBe(true);
    step = "reload_file";
    await page.reload();
    await expect(editor).toContainText(input.marker);
    step = "return_task";
    await page.goBack();
    await expect(page).toHaveURL(/\/issues\//);
    step = "reopen_card";
    await expect(card).toBeVisible();
    await card.getByRole("button").click();
    await expect(page.getByRole("heading", { name: skillName, exact: true })).toBeVisible();
    await expect(page.getByText(input.marker, { exact: true })).toBeVisible();
  } catch {
    // Browser errors can contain URLs, form values and skill contents. Keep only
    // the closed step code; do not attach the raw error as a message or cause.
    throw new SkillStudioFlowError(step);
  }
}
