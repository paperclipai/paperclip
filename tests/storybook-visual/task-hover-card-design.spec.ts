import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1100, height: 900 } });

async function openPreview(page: import("@playwright/test").Page, story = "playground") {
  await page.goto(`/iframe.html?id=design-task-hover-card--${story}&viewMode=story&globals=theme:dark`);
  await expect(page.getByTestId("task-hover-card-reference")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

test("task hover card follows the padded Paper layout and shared popover shadow", async ({ page }, testInfo) => {
  await openPreview(page);
  const card = page.getByTestId("task-hover-card-reference");
  await expect(card).toHaveCSS("width", "280px");
  await expect(card).toHaveCSS("padding", "16px");
  await expect(card).toHaveCSS("background-color", "rgb(26, 26, 26)");
  await expect(card).toHaveCSS("border-top-width", "1px");
  const shadow = await card.evaluate(element => getComputedStyle(element).getPropertyValue("--shadow-flyout").trim());
  expect(shadow).not.toBe("");
  await expect(card).toHaveCSS("box-shadow", "rgba(0, 0, 0, 0.2) 0px 4px 16px 0px");
  const title = card.locator('[data-slot="task-preview-title"]');
  await expect(title).toHaveCSS("font-size", "14px");
  await expect(title).toHaveCSS("font-weight", "600");
  await expect(title).toHaveCSS("line-height", "18px");
  await expect(title).toHaveCSS("-webkit-line-clamp", "2");
  await expect(title).toHaveCSS("color", "oklch(0.985 0 0)");
  await expect(card.locator('[data-slot="task-preview-id"]')).toHaveCSS("font-size", "12px");
  const description = card.locator('[data-slot="task-preview-description"]');
  await expect(description).toHaveCSS("font-size", "12px");
  await expect(description).toHaveCSS("line-height", "18px");
  await expect(description).toHaveCSS("-webkit-line-clamp", "3");
  await expect(card.getByTestId("quicklook-project")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("task-hover-card.png"), fullPage: true });
});

test("text links can disable previews while activity keeps them and summary rows stay opted out", async ({ page }) => {
  await openPreview(page);
  const popup = page.locator('[data-slot="popover-content"][data-quicklook]');
  const link = page.getByRole("link", { name: "Preview linked task PAP-173", exact: true });
  await link.hover();
  await expect(popup).toBeVisible();
  await expect(popup).toHaveCSS("padding", "16px");
  await expect(popup).toHaveCSS("width", "280px");
  await expect(popup.locator('[data-slot="task-preview-title"]')).toHaveText("Artifact Review: Finish the remaining approved wireframe gaps");
  await page.mouse.move(1000, 850);
  await expect(popup).toBeHidden();
  await link.focus();
  await expect(popup).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  await page.getByRole("button", { name: "Hover preview: On", exact: true }).click();
  await link.hover();
  await expect(page.getByRole("button", { name: "Hover preview: Off", exact: true })).toBeVisible();
  // Give the production hover-intent timer a chance to fire, then verify no card.
  await page.waitForTimeout(200);
  await expect(popup).toHaveCount(0);
  const activity = page.getByRole("region", { name: "Activity preview example", exact: true });
  await activity.getByRole("link").hover();
  await expect(popup).toBeVisible();
  const summary = page.getByRole("region", { name: "Summary without hover preview", exact: true });
  await summary.getByRole("link", { name: /^Open PAP-173:/ }).hover();
  await expect(popup).toBeHidden();
  await expect(summary.locator('[data-slot="task-row"]')).toHaveCSS("height", "44px");
});

test("missing descriptions collapse naturally without leaving an empty block", async ({ page }) => {
  await openPreview(page, "no-description");
  const card = page.getByTestId("task-hover-card-reference");
  await expect(card.locator('[data-slot="task-preview-description"]')).toHaveCount(0);
  await expect(card.locator('[data-slot="task-preview-title"]')).toBeVisible();
  await expect(card).toHaveCSS("padding", "16px");
});
