import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const storyId = "design-agent-task-list-trial";
const referencePng = process.env.TRIAL_REFERENCE_PNG;
if (!referencePng) throw new Error("TRIAL_REFERENCE_PNG is required: supply the screenshot frozen before implementation; visual verification cannot be omitted.");
const rows = (page: Page) => page.locator('.design-task-list-panel [data-slot="task-row"]');
const titles = (page: Page) => rows(page).locator('[data-slot="task-row-title"]');

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-15T00:00:00.000Z"));
  await page.goto(`/iframe.html?id=${storyId}&viewMode=story&globals=theme:dark`);
  await expect(page.getByTestId("design-page-shell")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(1439, 899);
});

test("matches the pre-implementation frozen reference and mounts canonical components", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await expect(rows(page)).toHaveCount(10);
  await expect(page.getByRole("columnheader")).toHaveText(["Task", "Task ID", "Last updated"]);
  await expect(page.getByRole("textbox", { name: "Search tasks", exact: true })).toHaveValue("");
  await expect(page.locator('.task-list-sort-button[data-active="true"]')).toHaveCount(0);
  await expect(page.getByRole("separator", { name: "Resize sidebar" })).toHaveAttribute("aria-valuenow", "240");
  const screenshot = await page.screenshot({ path: testInfo.outputPath("reproduction.png"), animations: "disabled" });
  expect(screenshot.equals(readFileSync(referencePng))).toBe(true);
  const components = await page.getByTestId("design-page-shell").evaluate(element => {
    const key = Object.keys(element).find(key => key.startsWith("__reactFiber$"))!;
    type Fiber = { type?: { name?: string; displayName?: string }; return?: Fiber; child?: Fiber; sibling?: Fiber };
    let root = (element as unknown as Record<string, Fiber>)[key]!;
    while (root.return) root = root.return;
    const names = new Set<string>();
    const visit = (fiber?: Fiber) => {
      if (!fiber) return;
      const name = fiber.type?.displayName ?? fiber.type?.name;
      if (name) names.add(name);
      visit(fiber.child);
      visit(fiber.sibling);
    };
    visit(root);
    return [...names];
  });
  for (const component of ["DesignPageShell", "SidebarShell", "DesignSidebar", "SidebarCompanyMenu", "SidebarAccountMenu", "TaskListToolbar", "TaskList", "TaskListViewport", "TaskListColumnHeader", "TaskListColumnSettings", "TaskRowGroup", "IssueRow", "CellMarquee"]) {
    expect(components).toContain(component);
  }
  const controller = readFileSync("ui/storybook/support/design-proposals/TasksReproductionTrial.tsx", "utf8");
  expect(controller).not.toMatch(/TaskListPagePreview|style=|<button|<input|<table|<svg|#[0-9a-f]{6}|\[\d+px\]/i);
  expect(errors).toEqual([]);
  const index = await (await page.request.get("/index.json")).json();
  expect(index.entries[storyId].title).toBe("Design proposals/AI Generated Test Pages/Tasks reproduction test");
});

for (const target of [storyId, "tasks-list-page-design--default"]) {
  test(`${target}: creator filters match their identity and collapsed matches become visible`, async ({ page }) => {
    await page.goto(`/iframe.html?id=${target}&viewMode=story&globals=theme:dark`);
    await expect(rows(page)).toHaveCount(10);
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await page.getByRole("region", { name: "Creator", exact: true }).getByRole("checkbox", { name: "Scott", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(rows(page)).toHaveCount(6);
    await page.getByRole("button", { name: "1", exact: true }).click();
    const creator = page.getByRole("region", { name: "Creator", exact: true });
    await creator.getByRole("checkbox", { name: "Scott", exact: true }).click();
    await creator.getByRole("checkbox", { name: "CodexCoder", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(rows(page)).toHaveCount(5);
    await page.getByRole("button", { name: "1", exact: true }).click();
    await page.getByRole("region", { name: "Creator", exact: true }).getByRole("checkbox", { name: "CodexCoder", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(rows(page)).toHaveCount(10);
    await page.getByRole("button", { name: "Collapse Improve connector reliability", exact: true }).click();
    await page.getByRole("textbox", { name: "Search tasks", exact: true }).fill("expired credential");
    await expect(rows(page)).toHaveCount(3);
    await expect(titles(page)).toHaveText(["Improve connector reliability", "Design reconnect and recovery flows", /Document connector recovery/]);
  });

  test(`${target}: metadata search, view/filter expansion and board matching share the collection contract`, async ({ page }) => {
    await page.goto(`/iframe.html?id=${target}&viewMode=story&globals=theme:dark`);
    await expect(rows(page)).toHaveCount(10);
    const search = page.getByRole("textbox", { name: "Search tasks", exact: true });
    await search.fill("CodexCoder");
    await expect(rows(page)).toHaveCount(8);
    await search.fill("");
    await page.getByRole("button", { name: "Collapse Improve connector reliability", exact: true }).click();
    await page.getByRole("button", { name: "Task view: All tasks", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Unread", exact: true }).click();
    await expect(rows(page)).toHaveCount(3);
    await expect(page.getByRole("button", { name: "Collapse Improve connector reliability", exact: true })).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("button", { name: "Task view: Unread", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "All tasks", exact: true }).click();
    await page.getByRole("button", { name: "Collapse Improve connector reliability", exact: true }).click();
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await page.getByRole("checkbox", { name: "In Review", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(rows(page)).toHaveCount(3);
    await expect(page.getByRole("button", { name: "Collapse Improve connector reliability", exact: true })).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("button", { name: "Board view", exact: true }).click();
    const board = page.locator(".design-task-board");
    await expect(board.getByText("Define connector health states", { exact: true })).toBeVisible();
    await expect(board.getByText("Review budget notifications", { exact: true })).toBeVisible();
    await expect(board.getByText("Improve connector reliability", { exact: true })).toHaveCount(0);
  });
}

test("read/unread hover and nested guides retain canonical behavior", async ({ page }, testInfo) => {
  const unread = titles(page).filter({ hasText: /^Improve connector reliability$/ });
  const read = titles(page).filter({ hasText: /^Design reconnect and recovery flows$/ });
  await expect(unread).toHaveCSS("font-weight", "600");
  await expect(read).toHaveCSS("font-weight", "400");
  const foreground = await unread.evaluate(element => getComputedStyle(element).color);
  expect(await read.evaluate(element => getComputedStyle(element).color)).not.toBe(foreground);
  for (const [title, weight] of [[read, "400"], [unread, "600"]] as const) {
    const background = () => title.evaluate(element => getComputedStyle(element.closest('[data-slot="task-row"]')!).backgroundColor);
    const originalBackground = await background();
    const bounds = (await title.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await expect(title).toHaveCSS("color", foreground);
    await expect(title).toHaveCSS("font-weight", weight);
    expect(await background()).not.toBe(originalBackground);
  }
  await page.screenshot({ path: testInfo.outputPath("unread-hover.png"), animations: "disabled" });
  const guides = page.locator('[data-slot="task-row-tree-guide"]');
  await expect(guides).toHaveCount(5);
  const positions = await titles(page).evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x));
  expect(positions[1] - positions[0]).toBe(24);
  expect(positions[3] - positions[1]).toBe(24);
  const nested = page.getByRole("button", { name: "Collapse Design reconnect and recovery flows", exact: true });
  await expect(nested).toHaveAttribute("aria-expanded", "true");
  await nested.click();
  await expect(rows(page)).toHaveCount(9);
  await page.getByRole("button", { name: "Collapse Improve connector reliability", exact: true }).click();
  await expect(rows(page)).toHaveCount(6);
  await page.getByRole("button", { name: "Expand all tasks", exact: true }).click();
  await expect(rows(page)).toHaveCount(10);
  await expect(nested).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "Collapse all tasks", exact: true }).click();
  await expect(rows(page)).toHaveCount(6);
  await page.getByRole("button", { name: "Expand all tasks", exact: true }).click();
  await expect(rows(page)).toHaveCount(10);
});

test("sorting, column toggles, reorder/reset and list/board state", async ({ page }) => {
  await page.getByRole("button", { name: "Task ID: sort ascending", exact: true }).click();
  await page.getByRole("button", { name: "Task ID: sort descending", exact: true }).click();
  await expect(titles(page).first()).toHaveText("Collect feedback on the refreshed task list");
  await page.getByRole("button", { name: "Columns", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Created by", exact: true }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: "Created by", exact: true })).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("columnheader")).toHaveCount(4);
  await page.getByRole("button", { name: "Board view", exact: true }).click();
  await expect(page.getByRole("region", { name: "Task board", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await expect(page.getByRole("columnheader")).toHaveCount(4);
  await expect(titles(page).first()).toHaveText("Collect feedback on the refreshed task list");
  await page.getByRole("button", { name: "Created by: sort ascending", exact: true }).press("Alt+ArrowLeft");
  await expect(page.getByRole("columnheader")).toHaveText(["Task", "Created by", "Task ID", "Last updated"]);
  await page.getByRole("button", { name: "Columns", exact: true }).click();
  await page.getByRole("menuitem", { name: "Reset defaults", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("columnheader")).toHaveText(["Task", "Task ID", "Last updated"]);
  await expect(page.locator('.task-list-sort-button[data-active="true"]')).toHaveCount(0);
  await expect(titles(page).first()).toHaveText("Improve connector reliability");
});

test("views, searches and canonical filters preserve ancestors", async ({ page }) => {
  await page.getByRole("button", { name: "Task view: All tasks", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Unread", exact: true }).click();
  await expect(rows(page)).toHaveCount(3);
  await page.reload();
  await expect(page.getByRole("button", { name: "Task view: Unread", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Task view: Unread", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "All tasks", exact: true }).click();
  for (const [label, count] of [["Inbox", 6], ["Needs attention", 3]] as const) {
    await page.getByRole("button", { name: "Task view: All tasks", exact: true }).click();
    await page.getByRole("menuitemradio", { name: label, exact: true }).click();
    await expect(rows(page)).toHaveCount(count);
    await page.getByRole("button", { name: `Task view: ${label}`, exact: true }).click();
    await page.getByRole("menuitemradio", { name: "All tasks", exact: true }).click();
  }
  const search = page.getByRole("textbox", { name: "Search tasks", exact: true });
  await search.fill("expired credential");
  await expect(rows(page)).toHaveCount(3);
  await expect(page.locator(".design-task-results")).toHaveText("1 matching task · Parent tasks included for context");
  await search.fill("no such task");
  await expect(page.getByText("No tasks match this view", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(rows(page)).toHaveCount(10);
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Search projects", exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: "In Review", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(rows(page)).toHaveCount(3);
});

test("canonical organization/account menus and sidebar resizing", async ({ page }) => {
  await page.getByRole("button", { name: "Global search", exact: true }).click();
  await expect(page.getByPlaceholder("Search tasks, agents, projects...", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("toolbar", { name: "Task list controls" }).getByRole("button", { name: "New Task", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New task", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open account menu", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Account", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Invite", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open Paperclip Storybook organization switcher", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: /Research Bureau/ })).toBeVisible();
  await page.getByRole("menuitem", { name: /Research Bureau/ }).click();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByText("No tasks in this organization", { exact: true })).toBeVisible();
  await expect(page.locator(".design-sidebar-recents a")).toHaveCount(0);
  const resize = page.getByRole("separator", { name: "Resize sidebar", exact: true });
  await resize.press("ArrowRight");
  await expect(resize).toHaveAttribute("aria-valuenow", "256");
  await page.reload();
  await expect(resize).toHaveAttribute("aria-valuenow", "256");
  const bounds = (await resize.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 32, bounds.y + bounds.height / 2);
  await page.mouse.up();
  await expect(resize).toHaveAttribute("aria-valuenow", "288");
});
