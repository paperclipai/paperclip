import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 1512, height: 862 } });

async function openPage(page: Page, story = "default") {
  await page.goto(`/iframe.html?id=tasks-list-page-design--${story}&viewMode=story&globals=theme:dark`);
  await expect(page.getByTestId("design-page-shell")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
}
const rows = (page: Page) => page.locator('.design-task-list-panel [data-slot="task-row"]');

test("toolbar outlines remain opaque and consistent across control fills without changing popover borders", async ({ page }, testInfo) => {
  await openPage(page);
  const controls = [
    page.locator(".design-task-search"),
    page.locator(".design-view-trigger"),
    page.locator(".design-view-toggle"),
    page.getByRole("button", { name: "Collapse all tasks", exact: true }),
    page.locator(".design-toolbar-filter > button"),
  ];
  const border = await controls[0].evaluate(element => getComputedStyle(element).borderTopColor);
  expect(border).not.toContain("/"); // An opaque color has no fractional alpha.
  expect(border).not.toBe("transparent");
  const fill = await controls[0].evaluate(element => getComputedStyle(element).backgroundColor);
  expect(await controls[1].evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(fill);
  for (const control of controls) {
    await expect(control).toHaveCSS("border-top-color", border);
    await expect(control).toHaveCSS("border-top-width", "1px");
  }
  await controls[1].hover();
  await expect(controls[1]).toHaveCSS("border-top-color", border);
  await page.getByRole("button", { name: "Board view", exact: true }).click();
  await expect(page.getByRole("button", { name: "Board view", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(controls[2]).toHaveCSS("border-top-color", border);
  await page.getByRole("textbox", { name: "Search tasks", exact: true }).focus();
  await expect(controls[0]).toHaveCSS("border-top-color", "oklch(0.985 0 0)");
  await expect(controls[0]).toHaveCSS("outline-style", "none");
  await expect.poll(() => controls[0].evaluate(element => getComputedStyle(element).boxShadow)).toContain("/ 0.2)");
  expect(await controls[0].evaluate(element => getComputedStyle(element).boxShadow)).toContain("3px");
  await controls[4].click();
  const popover = page.getByRole("dialog", { name: "Filters", exact: true });
  await expect(popover).toBeVisible();
  const popoverBorder = await popover.evaluate(element => getComputedStyle(element).borderTopColor);
  expect(popoverBorder).toContain("/ 0.1"); // Surface borders keep the translucent foundation token.
  await page.keyboard.press("Escape");
  await page.mouse.move(0, 0);
  await page.screenshot({ path: testInfo.outputPath("toolbar-consistent-borders.png"), fullPage: true });
});

test("tabbing through the toolbar shows the shared foreground edge and halo on every control", async ({ page }, testInfo) => {
  await openPage(page);
  const toolbar = page.getByRole("toolbar", { name: "Task list controls", exact: true });
  const search = toolbar.getByRole("textbox", { name: "Search tasks", exact: true });
  await search.focus();
  for (const control of [
    toolbar.getByRole("button", { name: "List view", exact: true }),
    toolbar.getByRole("button", { name: "Board view", exact: true }),
    toolbar.getByRole("button", { name: "Collapse all tasks", exact: true }),
    toolbar.locator(".design-toolbar-filter > button"),
    toolbar.getByRole("button", { name: "New Task", exact: true }),
  ]) {
    await page.keyboard.press("Tab");
    await expect(control).toBeFocused();
    await expect(control).toHaveCSS("outline-style", "solid");
    await expect(control).toHaveCSS("outline-color", "oklch(0.985 0 0)");
    await expect.poll(() => control.evaluate(element => getComputedStyle(element).boxShadow)).toContain("/ 0.2)");
    expect(await control.evaluate(element => getComputedStyle(element).boxShadow)).toContain("3px");
  }
  // The view menu precedes search and uses a different trigger wrapper.
  await search.focus();
  await page.keyboard.press("Shift+Tab");
  const view = toolbar.getByRole("button", { name: "Task view: All tasks", exact: true });
  await expect(view).toBeFocused();
  await expect(view).toHaveCSS("outline-color", "oklch(0.985 0 0)");
  await expect.poll(() => view.evaluate(element => getComputedStyle(element).boxShadow)).toContain("/ 0.2)");
  await page.screenshot({ path: testInfo.outputPath("toolbar-keyboard-focus.png"), fullPage: true });
});

test("full page uses the reviewed row contract and three default columns", async ({ page }, testInfo) => {
  await openPage(page);
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "Task list controls" })).toBeVisible();
  await expect(rows(page)).toHaveCount(10);
  await expect(page.getByRole("columnheader")).toHaveText(["Task", "Task ID", "Last updated"]);
  await expect(page.locator('.task-list-sort-button[data-active="true"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Group tasks", exact: true })).toHaveCount(0);
  for (const link of await page.locator(".design-sidebar-navigation a").all()) await expect(link).toHaveCSS("font-size", "14px");
  await expect(page.locator(".design-sidebar-new-task")).toHaveCSS("font-size", "14px");
  await expect(page.getByRole("button", { name: "Open account menu", exact: true })).toHaveCSS("font-size", "14px");
  await expect(page.getByRole("button", { name: "Open account menu", exact: true }).locator('[data-slot="avatar-fallback"]')).toHaveText("R");
  const recentLinks = page.locator(".design-sidebar-recents a");
  await expect(recentLinks).toHaveCount(5);
  await expect(page.locator(".design-sidebar-recents").getByText("Recent Tasks", { exact: true })).toBeVisible();
  for (const link of await recentLinks.all()) await expect(link).toHaveCSS("font-weight", "400");
  const dashboard = page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Dashboard", exact: true });
  await expect(dashboard).toHaveCSS("line-height", "21px");
  expect((await dashboard.locator("svg").boundingBox())!.x).toBe(28);
  expect((await dashboard.boundingBox())!.height).toBe(33);
  expect((await recentLinks.first().boundingBox())!.y).toBeGreaterThan((await page.getByRole("link", { name: "Audit", exact: true }).boundingBox())!.y);
  await expect(page.locator(".design-sidebar-account")).toHaveCSS("border-top-width", "0px");
  await expect(page.locator(".design-sidebar")).toHaveCSS("background-color", "oklch(0.269 0 0)");
  await expect(page.locator(".design-sidebar")).toHaveCSS("border-right-color", "oklch(1 0 0 / 0.1)");
  await expect(page.locator(".design-task-search")).toHaveCSS("background-color", "oklch(0.145 0 0)");
  const geometry = await page.getByTestId("design-page-shell").evaluate(shell => {
    const main = shell.querySelector<HTMLElement>(".design-page-main")!;
    const toolbar = shell.querySelector<HTMLElement>(".design-page-toolbar")!;
    const row = shell.querySelector<HTMLElement>('[data-slot="task-row"]')!;
    const title = row.querySelector<HTMLElement>('[data-slot="task-row-title"]')!;
    return {
      mainX: main.getBoundingClientRect().x,
      headerHeight: shell.querySelector(".design-page-header")!.getBoundingClientRect().height,
      toolbarHeight: toolbar.getBoundingClientRect().height,
      background: getComputedStyle(main).backgroundColor,
      rowHeight: row.getBoundingClientRect().height,
      titleSize: getComputedStyle(title).fontSize,
      titleLeading: getComputedStyle(title).lineHeight,
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  expect(geometry).toEqual({ mainX: 240, headerHeight: 60, toolbarHeight: 44, background: "rgb(26, 26, 26)", rowHeight: 44, titleSize: "14px", titleLeading: "16px", pageOverflow: false });
  await page.screenshot({ path: testInfo.outputPath("task-list-page.png"), fullPage: true });
  await page.locator(".design-sidebar").screenshot({ path: testInfo.outputPath("task-list-sidebar-paper.png") });
  const resize = page.getByRole("separator", { name: "Resize sidebar", exact: true });
  await resize.press("ArrowRight");
  await expect(resize).toHaveAttribute("aria-valuenow", "256");
  await page.reload();
  await expect(resize).toHaveAttribute("aria-valuenow", "256");
  expect((await page.locator(".design-page-main").boundingBox())!.x).toBe(256);
  await resize.hover();
  await expect(resize).toHaveCSS("cursor", "col-resize");
  await expect(resize.locator(":scope > div")).toHaveCSS("background-color", "oklch(0.556 0 0)");
  await page.screenshot({ path: testInfo.outputPath("task-list-sidebar-resize.png"), fullPage: true });
});

test("search preserves ancestor context, recovers from no results, and expansion works", async ({ page }) => {
  await openPage(page);
  await page.getByRole("button", { name: "Collapse all tasks" }).click();
  await expect(rows(page)).toHaveCount(6);
  await page.getByRole("button", { name: "Expand all tasks" }).click();
  await expect(rows(page)).toHaveCount(10);
  await page.getByRole("textbox", { name: "Search tasks", exact: true }).fill("expired credential");
  await expect(rows(page)).toHaveCount(3);
  await expect(page.locator(".design-task-results")).toHaveText("1 matching task · Parent tasks included for context");
  await expect(rows(page).locator('[data-slot="task-row-title"]')).toHaveText(["Improve connector reliability", "Design reconnect and recovery flows", /Document connector recovery behavior/]);
  await page.getByRole("textbox", { name: "Search tasks", exact: true }).fill("no matching task exists");
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByText("No tasks match this view", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(rows(page)).toHaveCount(10);
  await expect(page.getByRole("textbox", { name: "Search tasks", exact: true })).toHaveValue("");
});

test("views change the collection while keeping task families together", async ({ page }) => {
  await openPage(page);
  await page.getByRole("button", { name: "Task view: All tasks" }).click();
  await expect(page.getByRole("menuitemradio")).toHaveText(["Inbox", "Unread", "Needs attention", "All tasks"]);
  await page.getByRole("menuitemradio", { name: "Unread", exact: true }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(page.locator(".design-task-results")).toHaveText("3 matching tasks");
  await page.reload();
  await expect(page.getByRole("button", { name: "Task view: Unread" })).toBeVisible();
  await expect(rows(page)).toHaveCount(3);
  await page.getByRole("button", { name: "Task view: Unread" }).click();
  await page.getByRole("menuitemradio", { name: "Needs attention", exact: true }).click();
  await expect(page.locator(".design-task-results")).toHaveText("2 matching tasks · Parent tasks included for context");
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).locator('[data-slot="task-row-title"]')).toHaveText(["Improve connector reliability", "Define connector health states", "Review budget notifications"]);
  await page.getByRole("button", { name: "Task view: Needs attention" }).click();
  await page.getByRole("menuitemradio", { name: "Inbox", exact: true }).click();
  await expect(page.locator(".design-task-results")).toHaveText("6 matching tasks");
  await expect(rows(page)).toHaveCount(6);
  await page.reload();
  await page.getByRole("button", { name: "Task view: Inbox" }).click();
  await expect(page.getByRole("menuitemradio", { name: "Inbox", exact: true })).toBeChecked();
  await page.getByRole("menuitemradio", { name: "All tasks", exact: true }).click();
  await expect(rows(page)).toHaveCount(10);
  await expect(page.getByRole("rowgroup", { name: "Improve connector reliability task group", exact: true }).locator('[data-slot="task-row"]')).toHaveCount(5);
  await page.reload();
  await expect(page.getByRole("button", { name: "Task view: All tasks" })).toBeVisible();
  await expect(rows(page)).toHaveCount(10);
});

test("production filters operate on fixtures and list preferences survive board switching", async ({ page }) => {
  await openPage(page);
  await page.locator(".design-toolbar-filter > button").click();
  await page.getByRole("checkbox", { name: "Done", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".design-task-results")).toHaveText("2 matching tasks · Parent tasks included for context");
  await expect(rows(page)).toHaveCount(3);
  await page.getByRole("button", { name: "Board view", exact: true }).click();
  await expect(page.locator(".design-task-board")).toBeVisible();
  await expect(page.locator(".design-task-list-panel")).toBeHidden();
  await expect(page.getByRole("button", { name: "Collapse all tasks", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByRole("columnheader")).toHaveText(["Task", "Task ID", "Last updated"]);
});

test("refreshed filters use five searchable peer groups and the shared popover shadow", async ({ page }, testInfo) => {
  await openPage(page);
  await page.getByRole("button", { name: "Columns", exact: true }).click();
  const shadow = await page.getByRole("menu", { name: "Columns", exact: true }).evaluate(element => getComputedStyle(element).boxShadow);
  await page.keyboard.press("Escape");
  await page.locator(".design-toolbar-filter > button").click();
  const filters = page.getByRole("dialog", { name: "Filters", exact: true });
  await expect(filters).toHaveCSS("box-shadow", shadow);
  await expect(filters).toHaveCSS("background-color", "rgb(26, 26, 26)");
  await expect(filters.getByRole("heading", { level: 3 })).toHaveText(["Status", "Project", "Creator", "Assignee", "Label"]);
  const geometry = await filters.locator(".task-filter-group").evaluateAll(groups => groups.map(group => {
    const bounds = group.getBoundingClientRect();
    return { x: bounds.x, y: bounds.y, width: bounds.width };
  }));
  expect(new Set(geometry.map(group => group.y)).size).toBe(1);
  for (const [index, group] of geometry.entries()) {
    expect(group.width).toBe(200);
    if (index) expect(group.x - geometry[index - 1].x).toBe(216);
  }
  for (const name of ["projects", "creators", "assignees", "labels"]) await expect(filters.getByRole("textbox", { name: `Search ${name}`, exact: true })).toBeVisible();
  await expect(filters.getByText("Quick filters", { exact: true })).toHaveCount(0);
  for (const dot of await filters.locator(".task-filter-label-dot").all()) await expect(dot).toHaveCSS("border-radius", "5px");
  await page.screenshot({ path: testInfo.outputPath("task-filters-five-groups.png") });
  await filters.screenshot({ path: testInfo.outputPath("task-filters-panel.png") });

  const projectSearch = filters.getByRole("textbox", { name: "Search projects", exact: true });
  await projectSearch.fill("no such project");
  await expect(filters.getByText("No projects match.", { exact: true })).toBeVisible();
  await projectSearch.fill("Board");
  await filters.getByRole("checkbox", { name: "Board UI", exact: true }).click();
  await filters.getByRole("textbox", { name: "Search creators", exact: true }).fill("Scott");
  await filters.getByRole("checkbox", { name: "Scott", exact: true }).click();
  await filters.getByRole("textbox", { name: "Search assignees", exact: true }).fill("Codex");
  await filters.getByRole("checkbox", { name: "CodexCoder", exact: true }).click();
  await filters.getByRole("textbox", { name: "Search labels", exact: true }).fill("Design");
  await filters.getByRole("checkbox", { name: "Design system", exact: true }).click();
  await expect(rows(page).locator('[data-slot="task-row-title"]')).toHaveText(["Review budget notifications"]);
  await filters.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(rows(page)).toHaveCount(10);
  for (const input of await filters.getByRole("textbox").all()) await expect(input).toHaveValue("");
  await expect(filters.getByRole("checkbox", { checked: true })).toHaveCount(0);

  await page.setViewportSize({ width: 900, height: 862 });
  const bounds = (await filters.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(900);
  expect(await filters.locator(".task-filter-group").evaluateAll(groups => new Set(groups.map(group => group.getBoundingClientRect().y)).size)).toBeGreaterThan(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.keyboard.press("Escape");
  await expect(filters).toBeHidden();
  await expect(page.locator(".design-toolbar-filter > button")).toBeFocused();
});

test("New Task opens the shared task composer", async ({ page }) => {
  await openPage(page);
  await page.getByRole("toolbar", { name: "Task list controls" }).getByRole("button", { name: "New Task", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New task", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create task", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "New task", exact: true })).toBeHidden();
});

test("board has one horizontal scroll owner and fades only its clipped edges", async ({ page }, testInfo) => {
  await openPage(page);
  await page.getByRole("button", { name: "Board view", exact: true }).click();
  const board = page.locator(".design-task-board");
  const viewport = board.locator(".horizontal-scroll-viewport");
  const scroll = board.getByRole("region", { name: "Task board columns", exact: true });
  const scrollOwners = () => board.evaluate(element => [element, ...element.querySelectorAll("*"), element.closest("main")!].filter(node => {
    const style = getComputedStyle(node);
    return ["auto", "scroll"].includes(style.overflowX) && node.scrollWidth > node.clientWidth + 1;
  }).length);
  expect(await scrollOwners()).toBe(1);
  await expect(viewport).toHaveAttribute("data-overflow-left", "false");
  await expect(viewport).toHaveAttribute("data-overflow-right", "true");
  expect(await viewport.evaluate(element => getComputedStyle(element, "::before").opacity)).toBe("0");
  expect(await viewport.evaluate(element => getComputedStyle(element, "::after").opacity)).toBe("1");
  expect(await viewport.evaluate(element => getComputedStyle(element, "::after").pointerEvents)).toBe("none");

  await scroll.evaluate(element => element.scrollTo({ left: element.scrollWidth / 4 }));
  await expect(viewport).toHaveAttribute("data-overflow-left", "true");
  await expect(viewport).toHaveAttribute("data-overflow-right", "true");
  await page.screenshot({ path: testInfo.outputPath("task-board-scroll-fades.png") });
  await scroll.evaluate(element => element.scrollTo({ left: element.scrollWidth }));
  await expect(viewport).toHaveAttribute("data-overflow-left", "true");
  await expect(viewport).toHaveAttribute("data-overflow-right", "false");
  await scroll.hover();
  await page.mouse.wheel(-300, 0);
  await expect(viewport).toHaveAttribute("data-overflow-right", "true");

  await page.setViewportSize({ width: 2400, height: 862 });
  await expect(viewport).toHaveAttribute("data-overflow-left", "false");
  await expect(viewport).toHaveAttribute("data-overflow-right", "false");
  expect(await scrollOwners()).toBe(0);
  await page.setViewportSize({ width: 1000, height: 862 });
  await expect(viewport).toHaveAttribute("data-overflow-right", "true");
  expect(await scrollOwners()).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});

test("production organization switcher changes selection without leaking task fixtures", async ({ page }, testInfo) => {
  await openPage(page);
  await page.getByRole("button", { name: "Open Paperclip Storybook organization switcher", exact: true }).click();
  await expect(page.getByText("Organizations", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("task-list-organization-menu.png"), fullPage: true });
  await page.getByRole("menuitem", { name: /Research Bureau/ }).click();
  await expect(page.getByRole("button", { name: "Open Research Bureau organization switcher", exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByText("No tasks in this organization", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open Research Bureau organization switcher", exact: true }).click();
  await page.getByRole("menuitem", { name: /Paperclip Storybook/ }).click();
  await expect(rows(page)).toHaveCount(10);
});

test("production account menu fits profile, settings, Invite and theme actions", async ({ page }, testInfo) => {
  await openPage(page);
  const trigger = page.getByRole("button", { name: "Open account menu", exact: true });
  await trigger.click();
  await expect(page.getByRole("link", { name: "View profile", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  const invite = page.getByRole("link", { name: "Invite", exact: true });
  await expect(invite).toBeVisible();
  await expect(invite).toHaveAttribute("href", /\/company\/settings\/members\?tab=invites$/);
  await expect(page.getByRole("link", { name: "Documentation", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Switch to light mode", exact: true })).toBeVisible();
  const account = page.getByRole("dialog", { name: "Account", exact: true });
  await expect(account.locator('[data-slot="avatar-fallback"]')).toHaveText("R");
  const content = await account.evaluate(menu => {
    const last = menu.querySelector('[data-flyout-options] > button:last-of-type')!;
    return { bottomGap: menu.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom, minimumHeight: getComputedStyle(menu).minHeight };
  });
  expect(content.minimumHeight).toBe("0px");
  expect(content.bottomGap).toBe(13);
  await page.screenshot({ path: testInfo.outputPath("task-list-account-menu.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("link", { name: "View profile", exact: true })).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await invite.click();
  await expect(account).toBeHidden();
});

test("organization, account, Views and Columns share the refreshed flyout appearance", async ({ page }, testInfo) => {
  await openPage(page);
  const scenarios = [
    { trigger: "Open Paperclip Storybook organization switcher", role: "menu", name: /organization switcher/, option: /Research Bureau/, optionRole: "menuitem", screenshot: "flyout-organizations" },
    { trigger: "Open account menu", role: "dialog", name: "Account", option: "Settings", optionRole: "link", screenshot: "flyout-account" },
    // Radix names this menu from its trigger, so the accessible name changes with the selected view.
    { trigger: "Task view: All tasks", role: "menu", name: undefined, option: "Unread", optionRole: "menuitemradio", screenshot: "flyout-views" },
    { trigger: "Columns", role: "menu", name: "Columns", option: "Created by", optionRole: "menuitemcheckbox", screenshot: "flyout-columns" },
  ] as const;
  let sharedShadow: string | undefined;
  for (const scenario of scenarios) {
    await page.getByRole("button", { name: scenario.trigger, exact: true }).click();
    const menu = page.getByRole(scenario.role, { name: scenario.name, exact: true });
    await expect(menu).toHaveCSS("background-color", "rgb(26, 26, 26)");
    await expect(menu).toHaveCSS("border-width", "1px");
    await expect(menu).toHaveCSS("border-radius", "8px");
    const shadow = await menu.evaluate(element => getComputedStyle(element).boxShadow);
    expect(shadow).not.toBe("none");
    if (sharedShadow) expect(shadow).toBe(sharedShadow);
    sharedShadow = shadow;
    const option = menu.getByRole(scenario.optionRole, { name: scenario.option, exact: true });
    await expect(option).toHaveCSS("color", "oklch(0.708 0 0)");
    const selected = menu.locator('[data-selected="true"], [aria-checked="true"]').first();
    if (await selected.count()) {
      await expect(selected).toHaveCSS("color", "oklch(0.708 0 0)");
      await expect(selected.locator("svg.lucide-check")).toHaveCSS("color", "oklch(0.708 0 0)");
    }
    await option.hover();
    await expect(option).toHaveCSS("background-color", "rgb(51, 51, 51)");
    await expect(option).toHaveCSS("color", await menu.locator("[data-flyout-header]").evaluate(element => getComputedStyle(element).color));
    if (scenario.trigger === "Task view: All tasks") {
      const selected = menu.getByRole("menuitemradio", { name: "All tasks", exact: true });
      await expect(selected).toBeChecked();
      await expect(selected.locator("svg.lucide-check")).toBeVisible();
      await expect(selected.locator("svg.lucide-circle")).toHaveCount(0);
    }
    await page.screenshot({ path: testInfo.outputPath(`${scenario.screenshot}.png`) });
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  }
});

test("separate sidebar search target opens the production global palette", async ({ page }) => {
  await openPage(page);
  const organization = page.getByRole("button", { name: "Open Paperclip Storybook organization switcher", exact: true });
  const search = page.getByRole("button", { name: "Global search", exact: true });
  await expect(organization.locator("svg.lucide-chevrons-up-down")).toHaveCount(0);
  const organizationBounds = (await organization.boundingBox())!;
  expect((await search.boundingBox())!.x).toBeGreaterThanOrEqual(organizationBounds.x + organizationBounds.width);
  await search.click();
  const input = page.getByPlaceholder("Search tasks, agents, projects...", { exact: true });
  await expect(input).toBeVisible();
  await expect(page.getByText("Organizations", { exact: true })).toBeHidden();
  await input.fill("Codex");
  await expect(page.getByRole("option", { name: /CodexCoder/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(input).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Search tasks", exact: true })).toHaveValue("");
});

test("sidebar truncated labels share the table marquee and fade without extra tab stops", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openPage(page);
  const organization = page.getByRole("button", { name: "Open Paperclip Storybook organization switcher", exact: true });
  const label = organization.locator("[data-cell-marquee]");
  const recent = page.locator(".design-sidebar-recents a").first().locator("[data-cell-marquee]");
  for (const text of [label, recent]) {
    await expect(text).toHaveAttribute("data-truncated", "true");
    await expect(text).not.toHaveAttribute("tabindex");
    expect(await text.locator(".cell-marquee-viewport").evaluate(element => getComputedStyle(element).maskImage)).toContain("linear-gradient");
    await text.hover();
    await expect(text).toHaveAttribute("data-revealing", "true");
    await expect.poll(() => text.locator(".cell-marquee-content").evaluate(element => getComputedStyle(element).transform)).not.toBe("matrix(1, 0, 0, 1, 0, 0)");
    await page.mouse.move(0, 0);
    await expect(text).not.toHaveAttribute("data-revealing");
    await expect(text.locator(".cell-marquee-content")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  }
  const fitting = page.getByRole("link", { name: "Dashboard", exact: true }).locator("[data-cell-marquee]");
  await fitting.hover();
  await expect(fitting).not.toHaveAttribute("data-truncated");
  await expect(fitting).not.toHaveAttribute("data-revealing");
  await page.mouse.move(0, 0);
  await organization.focus();
  await expect(label).toHaveAttribute("data-revealing", "true");
  await page.keyboard.press("Escape");
  await expect(label).not.toHaveAttribute("data-revealing");
});

test("fractionally clipped recent titles reveal even when scrollWidth equals clientWidth", async ({ page }, testInfo) => {
  await openPage(page);
  const task = page.locator(".design-sidebar-recents").getByRole("link", { name: "Review budget notifications", exact: true });
  const label = task.locator("[data-cell-marquee]");
  const dimensions = await label.evaluate(element => {
    const content = element.querySelector(".cell-marquee-content")!;
    const range = document.createRange();
    range.selectNodeContents(content);
    return { client: element.clientWidth, scroll: content.scrollWidth, viewport: element.getBoundingClientRect().width, text: range.getBoundingClientRect().width };
  });
  expect(dimensions.scroll).toBe(dimensions.client);
  expect(dimensions.text).toBeGreaterThan(dimensions.viewport);
  expect(dimensions.text - dimensions.viewport).toBeLessThan(1);
  await expect(label).toHaveAttribute("data-truncated", "true");
  const bounds = (await task.boundingBox())!;
  // Hover the link padding, outside the text rectangle, just like the row's
  // visible hover state. Small overflow must still reveal the full final glyph.
  await page.mouse.move(bounds.x + 3, bounds.y + 3);
  await expect(label).toHaveAttribute("data-revealing", "true");
  await expect(label.locator(".cell-marquee-content")).toHaveCSS("overflow", "visible");
  await expect.poll(() => label.locator(".cell-marquee-content").evaluate(element => getComputedStyle(element).transform)).not.toBe("matrix(1, 0, 0, 1, 0, 0)");
  await page.locator(".design-sidebar").screenshot({ path: testInfo.outputPath("recent-task-marquee.png") });
  await page.mouse.move(0, 0);
  await expect(label).not.toHaveAttribute("data-revealing");
  await expect(label.locator(".cell-marquee-content")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
});

test("all-columns layout clips inside the table at a narrower desktop width", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1100, height: 862 });
  await openPage(page, "all-columns");
  await expect(page.getByRole("columnheader")).toHaveCount(9);
  const overflow = await page.locator(".task-list-columns-scroll").evaluate(element => ({ table: element.scrollWidth > element.clientWidth, page: document.documentElement.scrollWidth > window.innerWidth }));
  expect(overflow).toEqual({ table: true, page: false });
  await expect(page.locator(".design-toolbar-actions")).toBeInViewport();
  await page.getByRole("button", { name: "Task ID: sort ascending", exact: true }).click();
  await expect(page.locator('.task-list-sort-button[data-active="true"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Columns", exact: true }).click();
  await page.getByRole("menuitem", { name: "Reset defaults", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("columnheader")).toHaveText(["Task", "Task ID", "Last updated"]);
  await expect(page.locator('.task-list-sort-button[data-active="true"]')).toHaveCount(0);
  await expect(page.locator('[data-slot="task-list-sort-direction"]')).toHaveCount(0);
  await expect(page.locator('[role="columnheader"][aria-sort="none"]')).toHaveCount(3);
  await page.mouse.move(0, 0);
  for (const button of await page.locator(".task-list-sort-button").all()) await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.locator(".design-task-list-panel").screenshot({ path: testInfo.outputPath("task-list-reset-defaults.png") });
});
