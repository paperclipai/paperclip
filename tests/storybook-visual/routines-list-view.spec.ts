import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1440, height: 900 } });
const storageKey = "paperclip:routines-view:company-storybook:user:user-board";
for (const theme of ["light", "dark"]) {
  test(`routine columns and filters in ${theme}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`/iframe.html?id=routines-list-view--default&viewMode=story&globals=theme:${theme}`);
    const toolbar = page.getByRole("toolbar", { name: "Routines controls" });
    await expect(page.getByRole("row").filter({ hasText: "Weekly project review" })).toBeVisible();
    await expect(toolbar.locator("button, input, a").filter({ visible: true })).toHaveCount(8);
    await expect(page.getByRole("columnheader")).toHaveText(["Routine", "Project", "Agent", "Responsible user", "Last run", "Enabled", "Actions"]);
    await page.screenshot({ path: `test-results/routines-${theme}.png`, fullPage: true });
    await toolbar.getByRole("button", { name: "Filter routines", exact: true }).click();
    await page.screenshot({ path: `test-results/routines-filters-${theme}.png`, fullPage: true });
    await page.getByRole("checkbox", { name: "Alex Chen", exact: true }).click();
    await page.getByRole("checkbox", { name: "Enabled", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("row").filter({ hasText: "Daily company summary" })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "Weekly project review" })).toHaveCount(0);
    await expect(page.getByRole("row").filter({ hasText: "Nightly task triage" })).toHaveCount(0);
    await expect(page.getByTestId("routine-view-location")).toHaveAttribute("href", /responsibleUsers=person-alex/);
    await expect(page.getByTestId("routine-view-location")).toHaveAttribute("href", /statuses=active/);
    await toolbar.getByRole("button", { name: "Routine columns" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Project", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: "Last run", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("columnheader")).toHaveText(["Routine", "Agent", "Responsible user", "Enabled", "Actions"]);
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).columns, storageKey)).toEqual(["assignee", "responsibleUser", "enabled"]);
    await page.screenshot({ path: `test-results/routines-custom-columns-${theme}.png`, fullPage: true });
    expect(errors).toEqual([]);
  });
}

test("linked filters open on current and classic pages and mobile stays within the viewport", async ({ page }) => {
  await page.goto("/iframe.html?id=routines-list-view--linked-filters&viewMode=story");
  await expect(page.getByRole("row").filter({ hasText: "Daily company summary" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Weekly project review" })).toHaveCount(0);
  await page.goto("/iframe.html?id=routines-list-view--classic&viewMode=story");
  await expect(page.getByRole("button", { name: "New routine", exact: true })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Responsible user" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/iframe.html?id=routines-list-view--default&viewMode=story");
  await expect(page.getByRole("button", { name: "Routine columns" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/routines-mobile.png", fullPage: true });
});
