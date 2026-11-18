import { expect, test } from "@playwright/test";
import { routineViewStorageKey } from "../../ui/src/lib/routine-list-view";

test.use({ viewport: { width: 1440, height: 900 } });
const storageKey = routineViewStorageKey("company-storybook", "user-board");
for (const theme of ["light", "dark"]) {
  test(`routine columns and filters in ${theme}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(`/iframe.html?id=routines-list-view--default&viewMode=story&globals=theme:${theme}`);
    const toolbar = page.getByRole("toolbar", { name: "Routines controls" });
    await expect(page.getByRole("row").filter({ hasText: "Weekly project review" })).toBeVisible();
    expect(await toolbar.locator("button, input, a").filter({ visible: true }).evaluateAll(elements => elements.map(element => element.getAttribute("aria-label") ?? element.textContent))).toEqual([
      "New routine", "Search routines", "Sort routines", "Filter routines", "Group routines", "Routine columns", "View all tasks",
    ]);
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
  await page.getByRole("button", { name: "Dismiss folder suggestion", exact: true }).click();
  await page.screenshot({ path: "test-results/routines-mobile.png", fullPage: true });
});

test("Classic selection keeps column headings aligned and exposes routine links", async ({ page }) => {
  await page.goto("/iframe.html?id=routines-list-view--classic-selection&viewMode=story");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  const row = page.getByRole("row").filter({ hasText: "Daily company summary" });
  await expect(row.getByRole("link", { name: "Daily company summary", exact: true })).toHaveAttribute("href", /\/routines\/daily-summary$/);
  const heading = page.getByRole("columnheader", { name: "Routine", exact: true });
  const title = row.getByRole("cell").nth(1);
  const headingBox = await heading.boundingBox();
  const titleBox = await title.boundingBox();
  expect(Math.abs(headingBox!.x - titleBox!.x)).toBeLessThan(1);
  await row.getByRole("checkbox", { name: "Select Daily company summary" }).check();
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/routines-classic-selection.png", fullPage: true });
});


test("Classic Recent Runs hides routine list controls", async ({ page }) => {
  await page.goto("/iframe.html?id=routines-list-view--classic-runs&viewMode=story");
  const toolbar = page.getByRole("toolbar", { name: "Routines controls" });
  await expect(toolbar.getByRole("button", { name: "New routine", exact: true })).toBeVisible();
  await expect(toolbar.getByRole("link", { name: "View all tasks" })).toBeVisible();
  await expect(toolbar.getByRole("textbox", { name: "Search routines" })).toHaveCount(0);
  await expect(toolbar.getByRole("button", { name: "Routine columns" })).toHaveCount(0);
});
