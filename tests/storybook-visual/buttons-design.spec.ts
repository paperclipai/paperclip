import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 1600, height: 1000 } });
async function openButtons(page: Page, story = "playground") {
  await page.goto(`/iframe.html?id=design-buttons--${story}&viewMode=story&globals=theme:dark`);
  await expect(page.getByTestId("buttons-playground")).toBeVisible();
  return page.getByTestId("proposal-button-samples");
}

test("the playground uses a single sandbox inventory and proposal theme", async ({ page }) => {
  const samples = await openButtons(page);
  await expect(samples.locator("[data-button-variant]")).toHaveCount(7);
  await expect(samples.locator("[data-button-size]")).toHaveCount(8);
  await expect(page.locator(".design-proposal-theme")).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Button usage inventory", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Comparison layout", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Button playground controls", exact: true })).toHaveCount(1);
  await expect(samples.getByRole("region", { name: "All button variants", exact: true }).locator('[aria-busy="true"]')).toHaveCount(7);
});

test("on-canvas controls update the live sandbox specimen and reset it", async ({ page }) => {
  const samples = await openButtons(page);
  await page.getByLabel("Button label", { exact: true }).fill("Review changes");
  await page.getByLabel("Button variant", { exact: true }).selectOption("cta");
  await page.getByLabel("Button size", { exact: true }).selectOption("sm");
  await page.getByLabel("Button icon", { exact: true }).selectOption("trailing");
  await page.getByLabel("Button state", { exact: true }).selectOption("loading");
  const specimen = samples.getByRole("region", { name: "Live specimen", exact: true });
  const button = specimen.getByRole("button", { name: "Review changes", exact: true });
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute("aria-busy", "true");
  await expect(button).toHaveAttribute("data-variant", "cta");
  await expect(button).toHaveAttribute("data-size", "sm");
  await page.getByRole("button", { name: "Reset controls", exact: true }).click();
  await expect(page.getByLabel("Button label", { exact: true })).toHaveValue("Create task");
  await expect(specimen.getByRole("button", { name: "Create task", exact: true })).toBeEnabled();
});

test("sandbox context actions use local state and menus inherit the same theme", async ({ page }) => {
  await openButtons(page);
  const toolbar = page.getByRole("toolbar", { name: "Task list controls" });
  await toolbar.getByRole("button", { name: "Board view", exact: true }).click();
  await expect(toolbar.getByRole("button", { name: "Board view", exact: true })).toHaveAttribute("aria-pressed", "true");
  await toolbar.getByRole("button", { name: "Task view: All tasks", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Needs attention", exact: true }).click();
  await expect(toolbar.getByRole("button", { name: "Task view: Needs attention", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Star preview", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unstar preview", exact: true })).toHaveAttribute("aria-pressed", "true");
  await toolbar.getByRole("button", { name: "Filter", exact: true }).click();
  const filters = page.getByRole("dialog", { name: "Filters", exact: true });
  await expect(filters).toHaveCSS("background-color", "rgb(26, 26, 26)");
  const pageBackground = await page.getByTestId("buttons-playground").evaluate(element => getComputedStyle(element).backgroundColor);
  await expect(filters).toHaveCSS("background-color", pageBackground);
});

test("specimens retain real dimensions, state previews and surface controls", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const samples = await openButtons(page);
  const specimen = samples.getByRole("region", { name: "Live specimen", exact: true });
  await expect(page.getByLabel("Button size", { exact: true }).locator('option[value="sm"]')).toHaveText("Small · 36px high");
  await page.getByLabel("Button variant", { exact: true }).selectOption("cta");
  const button = specimen.getByRole("button", { name: "Create task", exact: true });
  await button.hover();
  await button.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
  const hoveredBackground = await button.evaluate(element => getComputedStyle(element).backgroundColor);
  await page.getByLabel("Button state", { exact: true }).selectOption("hover");
  await expect(button).toHaveCSS("background-color", hoveredBackground);
  await page.getByLabel("Button state", { exact: true }).selectOption("focus-visible");
  await expect(button).not.toHaveCSS("box-shadow", "none");
  await page.getByLabel("Button size", { exact: true }).selectOption("icon-xs");
  await expect(specimen.getByTestId("button-pixel-size")).toHaveText("24 × 24px");
  await expect(button).toHaveAttribute("aria-label", "Create task");
  await page.getByLabel("Button surface", { exact: true }).selectOption("muted");
  await expect(specimen.locator(".bg-muted").first()).toHaveCSS("background-color", "oklch(0.269 0 0)");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("sandbox-button-workbench.png") });
  expect(errors).toEqual([]);
});
