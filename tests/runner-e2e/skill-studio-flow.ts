import { expect, type Page } from "@playwright/test";

/** Shared browser story for classic and Cloud: activity card -> Studio -> saved task readback. */
export async function editCreatedSkillThroughStudio(input: {
  page: Page; skillId: string; skillName: string; marker: string; deadlineAt: number;
  read(): Promise<unknown>;
}) {
  const { page, skillName } = input;
  const card = page.getByRole("article", { name: `Skill created: ${skillName}`, exact: true });
  await expect(card).toHaveCount(1);
  await expect(card).toBeVisible();
  await card.getByRole("button").click();
  await expect(page.getByRole("heading", { name: skillName, exact: true })).toBeVisible();
  await expect(page.getByText("Verify checks.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open in Skill Studio", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/skills/studio/${input.skillId}$`));
  await expect(page.getByRole("combobox").filter({ hasText: skillName })).toBeVisible();
  const editor = page.getByRole("textbox", { name: "editable markdown", exact: true });
  await editor.click();
  await editor.press("ControlOrMeta+End");
  await editor.press("Enter");
  await editor.press("Enter");
  await editor.pressSequentially(input.marker);
  await page.getByRole("button", { name: /^Save$/ }).click();
  await expect.poll(async () => JSON.stringify(await input.read()).includes(input.marker),
    { timeout: Math.max(1, Math.min(30_000, input.deadlineAt - Date.now())) }).toBe(true);
  await page.reload();
  await expect(editor).toContainText(input.marker);
  await page.goBack();
  await expect(page).toHaveURL(/\/issues\//);
  await expect(card).toBeVisible();
  await card.getByRole("button").click();
  await expect(page.getByRole("heading", { name: skillName, exact: true })).toBeVisible();
  await expect(page.getByText(input.marker, { exact: true })).toBeVisible();
}
