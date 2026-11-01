import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1100, height: 862 } });

async function openSidebar(page: import("@playwright/test").Page, story = "default") {
  await page.goto(`/iframe.html?id=design-sidebar--${story}&viewMode=story&globals=theme:dark`);
  await expect(page.locator(".design-sidebar")).toBeVisible();
}

test("standalone sidebar supports resize, navigation states, search and production menus", async ({ page }, testInfo) => {
  await openSidebar(page);
  const sidebar = page.locator(".design-sidebar");
  await expect(sidebar).toHaveCSS("background-color", "oklch(0.269 0 0)");
  await expect(sidebar).toHaveCSS("background-clip", "padding-box");
  const headerBorder = await page.locator(".design-page-header").evaluate(element => getComputedStyle(element).borderBottomColor);
  await expect(sidebar).toHaveCSS("border-right-color", headerBorder);
  await expect(sidebar.getByRole("link", { name: "Tasks", exact: true })).toHaveAttribute("aria-current", "page");
  const dashboard = sidebar.getByRole("link", { name: "Dashboard", exact: true });
  await dashboard.hover();
  await expect(dashboard).toHaveCSS("background-color", "rgb(51, 51, 51)");
  await dashboard.focus();
  await expect(dashboard).toBeFocused();
  const resize = page.getByRole("separator", { name: "Resize sidebar" });
  await resize.press("ArrowRight");
  await expect(resize).toHaveAttribute("aria-valuenow", "256");
  await page.reload();
  await expect(resize).toHaveAttribute("aria-valuenow", "256");
  await resize.dblclick();
  await expect(resize).toHaveAttribute("aria-valuenow", "240");
  await expect(sidebar).toHaveCSS("width", "240px");
  await page.reload();
  await expect(resize).toHaveAttribute("aria-valuenow", "240");
  await sidebar.getByRole("button", { name: "Global search" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: testInfo.outputPath("sidebar-component.png") });

  await openSidebar(page, "organization-menu");
  const research = page.getByRole("menuitem", { name: /Research Bureau/ });
  await expect(research).toBeVisible();
  await research.click();
  await expect(sidebar.locator(".design-sidebar-recents a")).toHaveCount(0);

  await openSidebar(page, "account-menu");
  await expect(page.getByRole("link", { name: "Invite", exact: true })).toBeVisible();
});

test("sidebar specimens cover narrow, overflowing and empty recents", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openSidebar(page, "narrow");
  await expect(page.getByRole("separator", { name: "Resize sidebar" })).toHaveAttribute("aria-valuenow", "208");
  await openSidebar(page, "long-labels");
  const label = page.locator(".design-sidebar-recents a").first().locator("[data-cell-marquee]");
  await expect(label).toHaveAttribute("data-truncated", "true");
  await label.hover();
  await expect.poll(() => label.locator(".cell-marquee-content").evaluate(element => getComputedStyle(element).transform)).not.toBe("matrix(1, 0, 0, 1, 0, 0)");
  await openSidebar(page, "many-recent-tasks");
  await expect(page.locator(".design-sidebar-recents a")).toHaveCount(30);
  const recents = page.getByRole("region", { name: "Recent tasks", exact: true });
  expect(await recents.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  const navigation = page.locator(".design-sidebar-navigation");
  const header = page.getByText("Recent Tasks", { exact: true });
  const headerY = (await header.boundingBox())!.y;
  const navScroll = await navigation.evaluate(element => element.scrollTop);
  await expect(recents).toHaveCSS("scrollbar-color", "rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)");
  await recents.hover();
  await expect(recents).not.toHaveAttribute("data-scroll-active");
  await page.mouse.wheel(0, 300);
  await expect(recents).toHaveAttribute("data-scroll-active", "true");
  await expect(recents).toHaveCSS("scrollbar-color", "oklch(0.4 0 0) rgba(0, 0, 0, 0)");
  expect(await recents.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await navigation.evaluate(element => element.scrollTop)).toBe(navScroll);
  expect((await header.boundingBox())!.y).toBe(headerY);
  await expect(recents).not.toHaveAttribute("data-scroll-active");
  await expect(recents).toHaveCSS("scrollbar-color", "rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)");
  await expect(page.getByRole("button", { name: "Open account menu", exact: true })).toBeInViewport();
  await openSidebar(page, "empty-recent-tasks");
  await expect(page.locator(".design-sidebar-recents")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Tasks", exact: true })).toBeVisible();
});

test("organization title resets after menu dismissal outside its hit area", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openSidebar(page);
  const trigger = page.getByRole("button", { name: /organization switcher/ });
  const label = trigger.locator("[data-cell-marquee]");
  for (const dismissal of ["escape", "outside"]) {
    await trigger.hover();
    await expect(label).toHaveAttribute("data-revealing", "true");
    await expect.poll(() => label.locator(".cell-marquee-content").evaluate(element => getComputedStyle(element).transform)).not.toBe("matrix(1, 0, 0, 1, 0, 0)");
    await trigger.click();
    await expect(page.getByRole("menuitem", { name: /Research Bureau/ })).toBeVisible();
    await page.mouse.move(800, 200);
    if (dismissal === "escape") await page.keyboard.press("Escape");
    else await page.mouse.click(800, 200);
    await expect(page.getByRole("menuitem", { name: /Research Bureau/ })).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(label).not.toHaveAttribute("data-revealing");
    await expect(label.locator(".cell-marquee-content")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  }
  // Restored focus remains usable; tabbing away and back is a new interaction.
  await trigger.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(trigger).toBeFocused();
  await expect(label).toHaveAttribute("data-revealing", "true");
});

test("light sidebar uses production surface, navigation contrast and selected colors", async ({ page }) => {
  await page.goto('/iframe.html?id=design-sidebar--default&viewMode=story&globals=theme:light');
  const sidebar = page.locator('.design-sidebar');
  await expect(sidebar).toBeVisible();
  // The production primary sidebar renders a border/background blend, not --sidebar.
  await expect(sidebar).toHaveCSS('background-color', 'color(srgb 0.948957 0.949131 0.949147)');
  const tasks = sidebar.getByRole('link', { name: 'Tasks', exact: true });
  await expect(tasks).toHaveCSS('background-color', 'oklch(0.88 0 0)');
  await expect(tasks).toHaveCSS('color', 'oklch(0.205 0 0)');
  const projects = sidebar.getByRole('link', { name: 'Projects', exact: true });
  await expect(projects).toHaveCSS('color', 'oklab(0.145 0 0 / 0.8)');
  await projects.hover();
  await expect(projects).toHaveCSS('background-color', 'oklch(0.88 0 0)');
  await expect(projects).toHaveCSS('color', 'oklch(0.205 0 0)');
});
