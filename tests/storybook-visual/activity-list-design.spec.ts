import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1200, height: 900 } });
async function openActivity(page: import("@playwright/test").Page, story = "playground") {
  await page.goto(`/iframe.html?id=design-activity-list--${story}&viewMode=story&globals=theme:dark`);
  await expect(page.getByRole("list", { name: "Recent activity", exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

test("activity shares task densities and responsive metadata without inventing task IDs", async ({ page }, testInfo) => {
  await openActivity(page);
  const list = page.getByRole("list", { name: "Recent activity", exact: true });
  const rows = list.locator('[data-slot="activity-row"]');
  await expect(rows).toHaveCount(6);
  await expect(list.locator('[data-slot="avatar-fallback"]')).toHaveText(["R", "R", "R", "R", "S"]);
  await expect(rows.nth(1)).toHaveAttribute("href", "/PAP/agents/agent-codex");
  await expect(rows.nth(2)).toHaveAttribute("href", /\/PAP\/projects\//);
  await expect(rows.nth(3)).toHaveAttribute("href", "/PAP/approvals/approval-budget");
  await expect(rows.nth(4)).toHaveAttribute("href", "/PAP/agents/agent-codex/runs/run-storybook");
  await expect(rows.nth(5)).not.toHaveAttribute("href");
  await expect(list.locator('[data-slot="task-row-identifier"]')).toHaveCount(1);
  for (const density of ["Comfortable (44px)", "Compact (32px)"]) {
    await page.getByRole("group", { name: "Row density", exact: true }).getByRole("button", { name: density, exact: true }).click();
    for (const width of ["Standard", "Narrow", "Smallest"]) {
      await page.getByRole("group", { name: "Container width", exact: true }).getByRole("button", { name: width, exact: true }).click();
      for (const row of await rows.all()) {
        await expect(row).toHaveCSS("height", density.startsWith("Compact") ? "32px" : "44px");
        await expect(row.locator('[data-slot="task-row-title"]')).toHaveCSS("font-size", "14px");
        await expect(row.locator('[data-slot="task-row-title"]')).toHaveCSS("line-height", "16px");
        await expect(row.locator('[data-slot="task-row-timestamp"]')).toBeVisible({ visible: width !== "Smallest" });
      }
      await expect(rows.first().locator('[data-slot="task-row-identifier"]')).toBeVisible({ visible: width === "Standard" });
      expect(await list.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
  }
  await page.getByRole("button", { name: "Narrow", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("activity-list-narrow.png"), fullPage: true });
});

test("activity keeps task hover cards and cell-local fade/marquee while non-task links stay independent", async ({ page }) => {
  await openActivity(page, "narrow");
  const rows = page.locator('[data-slot="activity-row"]');
  const row = rows.first();
  const title = row.locator('[data-slot="task-row-title"]');
  await expect(title).toHaveAttribute("data-truncated", "true");
  expect(await title.locator(".cell-marquee-viewport").evaluate(element => getComputedStyle(element).maskImage)).toContain("linear-gradient");
  const color = await title.evaluate(element => getComputedStyle(element).color);
  await title.hover();
  await expect(title).toHaveAttribute("data-revealing", "true");
  expect(await title.evaluate(element => getComputedStyle(element).color)).not.toBe(color);
  const popup = page.locator('[data-quicklook][data-slot="popover-content"]');
  await expect(popup).toBeVisible();
  await expect(popup.locator('[data-slot="task-preview-id"]')).toHaveText("PAP-431");
  await row.locator('[data-slot="task-row-timestamp"]').hover();
  await expect(title).not.toHaveAttribute("data-revealing");
  await rows.nth(1).hover();
  await expect(popup).toBeHidden();
  await expect(title).not.toHaveAttribute("data-revealing");
  await row.focus();
  await expect(popup).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
});

test("reference changes remain available below the fixed-height activity row", async ({ page }) => {
  await openActivity(page, "reference-changes");
  await expect(page.getByLabel("Added references", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Removed references", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Task PAP-400: Superseded connector plan", exact: true })).toBeVisible();
  await expect(page.locator('[data-slot="activity-row"]').first()).toHaveCSS("height", "44px");
});
