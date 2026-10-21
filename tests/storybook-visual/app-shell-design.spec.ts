import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 1200, height: 800 } });

async function openShell(page: Page, story: string) {
  await page.goto(`/iframe.html?id=design-app-shell--${story}&viewMode=story&globals=theme:dark`);
  await expect(page.getByTestId("design-page-shell")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

test("two and three panes share the sidebar, maintain boundaries, and fit narrower desktops", async ({ page }, testInfo) => {
  await openShell(page, "two-panes");
  const main = page.getByRole("main");
  const sidebar = page.locator(".design-sidebar");
  const resize = page.getByRole("separator", { name: "Resize sidebar", exact: true });
  await expect(page.getByRole("complementary")).toHaveCount(0);
  await expect(sidebar).toHaveCSS("width", "240px");
  expect((await main.boundingBox())!.width).toBe(960);
  await resize.press("ArrowRight");
  await expect(resize).toHaveAttribute("aria-valuenow", "256");
  expect((await main.boundingBox())!.width).toBe(944);
  await page.reload();
  await expect(resize).toHaveAttribute("aria-valuenow", "256");
  await page.screenshot({ path: testInfo.outputPath("app-shell-two-panes.png") });

  await openShell(page, "three-panes");
  const right = page.getByRole("complementary", { name: "Right sidebar", exact: true });
  await expect(resize).toHaveAttribute("aria-valuenow", "240");
  await expect(right).toHaveCSS("width", "320px");
  await expect(right).toHaveCSS("background-color", "rgb(26, 26, 26)");
  await expect(right).toHaveCSS("border-left-width", "1px");
  await expect(right).toHaveCSS("border-left-color", "oklch(1 0 0 / 0.1)");
  await expect(page.locator(".design-page-main")).toHaveCSS("background-color", "rgb(26, 26, 26)");
  await expect(sidebar).toHaveCSS("background-color", "oklch(0.269 0 0)");
  const mainBox = (await main.boundingBox())!;
  const rightBox = (await right.boundingBox())!;
  expect(mainBox.x + mainBox.width).toBe(rightBox.x);
  expect(rightBox.x + rightBox.width).toBe(1200);
  await page.screenshot({ path: testInfo.outputPath("app-shell-three-panes.png") });

  await page.setViewportSize({ width: 960, height: 800 });
  await expect(right).toHaveCSS("width", "288px");
  expect((await main.boundingBox())!.width).toBe(432);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("app-shell-three-panes-narrow.png") });
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await skip.focus();
  await skip.press("Enter");
  await expect(main).toBeFocused();
});

test("main and right content scroll independently while headers and sidebar stay in place", async ({ page }) => {
  await openShell(page, "independent-scrolling");
  const main = page.getByRole("main");
  const right = page.getByRole("region", { name: "Right sidebar content", exact: true });
  const sidebar = page.locator(".design-sidebar");
  const header = page.getByRole("heading", { name: "App shell", exact: true });
  const rightHeader = page.getByRole("complementary", { name: "Right sidebar", exact: true }).locator("header");
  const originalHeaderY = (await header.boundingBox())!.y;
  const originalRightHeaderY = (await rightHeader.boundingBox())!.y;
  const originalSidebarY = (await sidebar.boundingBox())!.y;
  for (const pane of [main, right]) {
    await expect(pane).toHaveCSS("scrollbar-color", "rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)");
  }
  await main.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => main.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(main).toHaveAttribute("data-scroll-active", "true");
  expect(await right.evaluate(element => element.scrollTop)).toBe(0);
  // Focus a pane with overflow and scroll it using the keyboard.
  await right.focus();
  await right.press("PageDown");
  await expect.poll(() => right.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(right).toHaveAttribute("data-scroll-active", "true");
  const mainScroll = await main.evaluate(element => element.scrollTop);
  await right.hover();
  await page.mouse.wheel(0, 400);
  expect(await main.evaluate(element => element.scrollTop)).toBe(mainScroll);
  expect((await header.boundingBox())!.y).toBe(originalHeaderY);
  expect((await rightHeader.boundingBox())!.y).toBe(originalRightHeaderY);
  expect((await sidebar.boundingBox())!.y).toBe(originalSidebarY);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  for (const pane of [main, right]) {
    await expect(pane).not.toHaveAttribute("data-scroll-active", "true");
    await expect(pane).toHaveCSS("scrollbar-color", "rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)");
  }
});

test("right divider matches the left highlight, resizes in both directions, persists and resets", async ({ page }, testInfo) => {
  await openShell(page, "three-panes");
  const pane = page.getByRole("complementary", { name: "Right sidebar", exact: true });
  const resize = page.getByRole("separator", { name: "Resize right sidebar", exact: true });
  const left = page.getByRole("separator", { name: "Resize sidebar", exact: true });
  await expect(resize).toHaveAttribute("aria-valuenow", "320");
  await expect(resize).toHaveCSS("width", "8px");
  const highlight = await left.evaluate(element => getComputedStyle(element).getPropertyValue("--ring").trim());
  expect(highlight).toBe("oklch(0.556 0 0)");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ring").trim())).toBe("oklch(0.985 0 0)");
  await left.hover();
  await expect(left.locator("div")).toHaveCSS("background-color", highlight);
  await resize.hover();
  await expect(resize.locator("div")).toHaveCSS("background-color", highlight);

  const box = (await resize.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 160);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + 160, { steps: 8 });
  await expect(pane).toHaveCSS("width", "440px");
  await expect(resize).toHaveAttribute("data-dragging", "");
  await page.mouse.up();
  await expect(resize).not.toHaveAttribute("data-dragging", "");
  await page.reload();
  await expect(pane).toHaveCSS("width", "440px");
  await resize.press("ArrowRight");
  await expect(pane).toHaveCSS("width", "424px");
  await resize.press("ArrowLeft");
  await expect(pane).toHaveCSS("width", "440px");
  await page.getByRole("button", { name: "Maximize side panel", exact: true }).click();
  await expect(resize).toHaveCount(0);
  await page.getByRole("button", { name: "Restore side panel", exact: true }).click();
  await expect(pane).toHaveCSS("width", "440px");
  await page.setViewportSize({ width: 960, height: 800 });
  await expect(pane).toHaveCSS("width", "400px");
  expect((await page.getByRole("main").boundingBox())!.width).toBe(320);
  await resize.dblclick();
  await expect(pane).toHaveCSS("width", "288px");
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect(pane).toHaveCSS("width", "320px");
  await page.reload();
  await expect(pane).toHaveCSS("width", "320px");
  await resize.press("Home");
  await expect(pane).toHaveCSS("width", "260px");
  await resize.press("End");
  await expect(pane).toHaveCSS("width", "640px");
  await resize.dblclick();
  await expect(pane).toHaveCSS("width", "320px");
  await expect(left).toHaveAttribute("aria-valuenow", "240");
  await resize.hover();
  await page.screenshot({ path: testInfo.outputPath("app-shell-right-resize-highlight.png") });
});

test("both pane dividers animate a double-click reset while manual sizing stays immediate", async ({ page }) => {
  await openShell(page, "three-panes");
  const left = page.getByRole("separator", { name: "Resize sidebar", exact: true });
  const leftShell = page.locator(".design-page-navigation");
  const leftPanel = leftShell.locator(".sidebar-shell-panel");
  const right = page.getByRole("separator", { name: "Resize right sidebar", exact: true });
  const rightPane = page.getByRole("complementary", { name: "Right sidebar", exact: true });
  // Observe real CSS transitions, so this proves motion rather than only its end state.
  for (const [pane, property] of [[leftShell, "width"], [leftPanel, "width"], [rightPane, "flex-basis"]] as const) {
    await pane.evaluate((element, propertyName) => {
      element.addEventListener("transitionrun", event => {
        const transition = event as TransitionEvent;
        if (event.target !== element || transition.propertyName !== propertyName) return;
        element.setAttribute("data-observed-reset-transition", propertyName);
        element.setAttribute("data-observed-reset-duration", getComputedStyle(element).transitionDuration);
      });
    }, property);
  }
  await left.press("End");
  await expect(leftShell).toHaveCSS("width", "420px");
  await expect(leftShell).toHaveCSS("transition-duration", "0s");
  await left.dblclick();
  for (const pane of [leftShell, leftPanel]) {
    await expect(pane).toHaveAttribute("data-observed-reset-transition", "width");
    await expect(pane).toHaveAttribute("data-observed-reset-duration", "0.2s");
    await expect(pane).toHaveCSS("width", "240px");
  }
  await expect(leftShell).not.toHaveAttribute("data-width-resetting", "true");
  await right.press("End");
  await expect(rightPane).toHaveCSS("width", "640px");
  await expect(rightPane).toHaveCSS("transition-duration", "0s");
  await right.dblclick();
  await expect(rightPane).toHaveAttribute("data-observed-reset-transition", "flex-basis");
  await expect(rightPane).toHaveAttribute("data-observed-reset-duration", "0.2s");
  await expect(rightPane).toHaveCSS("width", "320px");
  await expect(rightPane).not.toHaveAttribute("data-width-resetting", "true");
});

test("reduced motion resets both panes instantly", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openShell(page, "three-panes");
  for (const [name, selector, width] of [
    ["Resize sidebar", ".design-page-navigation", "240px"],
    ["Resize right sidebar", ".design-page-aside", "320px"],
  ]) {
    const resize = page.getByRole("separator", { name, exact: true });
    const pane = page.locator(selector);
    await resize.press("End");
    await resize.dblclick();
    await expect(pane).toHaveCSS("width", width);
    await expect(pane).toHaveCSS("transition-duration", "0s");
    expect(await pane.evaluate(element => element.getAnimations().length)).toBe(0);
  }
});

test("production pane controls add and close tabs, maximize, restore, and reopen the pane", async ({ page }, testInfo) => {
  await openShell(page, "three-panes");
  const right = page.getByRole("complementary", { name: "Right sidebar", exact: true });
  await expect(right.getByRole("tab")).toHaveCount(4);
  await expect(right.getByRole("tabpanel")).toHaveAccessibleName("Properties");
  await page.getByRole("button", { name: "Maximize side panel", exact: true }).click();
  await expect(right).toHaveCSS("width", "960px");
  await expect(page.getByRole("main")).toHaveCount(0);
  await expect(page.locator(".design-sidebar")).toBeVisible();

  await right.getByRole("tab", { name: "Tasks", exact: true }).click();
  await expect(right.getByRole("tabpanel")).toHaveAccessibleName("Tasks");
  await right.getByRole("tab", { name: "Tasks", exact: true }).press("ArrowRight");
  await expect(right.getByRole("tabpanel")).toHaveAccessibleName("Plan");
  await right.getByRole("tab", { name: "Tasks", exact: true }).click();
  await right.getByRole("button", { name: "Close Tasks", exact: true }).click();
  await expect(right.getByRole("tab", { name: "Tasks", exact: true })).toHaveCount(0);
  await expect(right.getByRole("tabpanel")).toHaveAccessibleName("Plan");
  await right.getByRole("button", { name: "Open a new tab", exact: true }).click();
  await page.getByRole("option", { name: "Tasks", exact: true }).click();
  await expect(right.getByRole("tabpanel")).toHaveAccessibleName("Tasks");
  await expect(right.getByRole("tab")).toHaveCount(4);
  await right.getByRole("tab", { name: "Tasks", exact: true }).hover();
  await right.getByRole("button", { name: "Close Tasks", exact: true }).click();
  await expect(right.getByRole("tabpanel")).toHaveAccessibleName("Artifacts");

  await page.getByRole("button", { name: "Restore side panel", exact: true }).click();
  await expect(right).toHaveCSS("width", "320px");
  await expect(page.getByRole("main")).toBeVisible();
  await page.getByRole("button", { name: "Close side panel", exact: true }).click();
  await expect(right).toHaveCount(0);
  const toggle = page.getByRole("button", { name: "Toggle side panel", exact: true });
  await expect(toggle).toBeFocused();
  await toggle.click();
  await expect(right.getByRole("tabpanel")).toHaveAccessibleName("Artifacts");
  await expect(right.getByRole("tab")).toHaveCount(3);

  // Closing the final tab leaves the production launcher available for recovery.
  for (const label of ["Artifacts", "Plan", "Properties"]) {
    const tab = right.getByRole("tab", { name: label, exact: true });
    await tab.click();
    await right.getByRole("button", { name: `Close ${label}`, exact: true }).click();
  }
  await expect(right.getByRole("tabpanel")).toHaveCount(0);
  await right.getByRole("option", { name: "Properties", exact: true }).click();
  await expect(right.getByRole("tabpanel")).toHaveAccessibleName("Properties");
  await page.screenshot({ path: testInfo.outputPath("app-shell-production-pane-controls.png") });
});
