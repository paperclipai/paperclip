import { expect, test, type Page } from "@playwright/test";

const states = ["expanded", "selected-subtask", "long-titles", "narrow", "empty-recents", "keyboard-focus", "section-collapsed", "classic"];
async function open(page: Page, state: string, theme = "dark") {
  await page.goto(`/iframe.html?id=design-recent-subtasks--${state}&viewMode=story&globals=theme:${theme}`);
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    __STORYBOOK_ADDONS_CHANNEL__?: { data: Record<string, Array<{ status?: string }>> };
  }).__STORYBOOK_ADDONS_CHANNEL__?.data.storyFinished?.[0]?.status), { timeout: 60_000 }).toBeDefined();
  const outcome = await page.evaluate(() => {
    const result = (window as unknown as { __STORYBOOK_ADDONS_CHANNEL__?: { data: { storyFinished?: Array<{ status: string }> } } }).__STORYBOOK_ADDONS_CHANNEL__?.data.storyFinished?.[0];
    return result?.status;
  });
  expect(outcome).toBe("success");
}

for (const theme of ["light", "dark"]) {
  for (const state of states) test(`${state} in ${theme}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await open(page, state, theme);

    if (state === "expanded" || state === "narrow") {
      const recents = page.getByRole("region", { name: "Recents", exact: true });
      const links = await recents.getByRole("link").all();
      expect(links).toHaveLength(4);
      const rows = await Promise.all(links.map(link => link.boundingBox()));
      expect(rows.every(row => row?.x === rows[0]?.x)).toBe(true);
      const overflow = await recents.evaluate(element => element.scrollWidth - element.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    }

    expect(errors).toEqual([]);
    await page.locator(".coordinator-workspace").screenshot({ path: testInfo.outputPath(`${state}-${theme}.png`), animations: "disabled" });
  });
}

test("Classic keeps recent task actions on flat rows", async ({ page }) => {
  await open(page, "classic");
  const child = page.getByRole("link", { name: "Verify the saved workspace" });
  const parent = page.getByRole("link", { name: "Ship the project workspace" });
  expect((await child.boundingBox())!.x).toBe((await parent.boundingBox())!.x);
  await child.hover();
  await page.getByRole("button", { name: "More actions for Verify the saved workspace" }).click();
  await expect(page.getByRole("menuitem", { name: "Archive", exact: true })).toBeVisible();
});
