import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const evidence = process.env.TRIAL_2_EVIDENCE_DIR;
if (!evidence) throw new Error("TRIAL_2_EVIDENCE_DIR is required; visual evidence may not be omitted.");
const reference = join(evidence, "reference.png");
const clock = "2026-10-15T00:00:00.000Z";

test.use({
  viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1,
  colorScheme: "dark", reducedMotion: "reduce", locale: "en-US",
  timezoneId: "America/Los_Angeles",
  launchOptions: { executablePath: process.env.TRIAL_CHROMIUM_EXECUTABLE },
});

const storyId = "design-agent-task-list-trial-2--default";
const rows = (page: Page) => page.locator('.design-task-list-panel [data-slot="task-row"]');
const titles = (page: Page) => rows(page).locator('[data-slot="task-row-title"]');

async function selectView(page: Page, label: string) {
  await page.getByRole("button", { name: /^Task view:/ }).click();
  await page.getByRole("menuitemradio", { name: label, exact: true }).click();
}

async function componentNames(page: Page) {
  return page.getByTestId("design-page-shell").evaluate(element => {
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
}

test.describe("independent second trial", () => {
  test.skip(process.env.TRIAL_2_FREEZE === "1", "Freeze runs before implementation exists.");
  test.beforeEach(async ({ page }) => {
    await openStory(page, storyId);
  });

  test("pixel comparison executes against the immutable frozen reference", async ({ page, browser }, testInfo) => {
    expect(existsSync(reference), "Frozen reference must exist; do not substitute a new baseline").toBe(true);
    const frozen = readFileSync(reference);
    const conditions = JSON.parse(readFileSync(join(evidence!, "capture-conditions.json"), "utf8"));
    expect(createHash("sha256").update(frozen).digest("hex")).toBe(conditions.sha256);
    expect(browser.version()).toBe(conditions.browser);
    expect(conditions.clock).toBe(clock);
    await expect(rows(page)).toHaveCount(10);
    await expect(page.getByRole("columnheader")).toHaveText(["Task", "Task ID", "Last updated"]);
    await expect(page.getByRole("button", { name: "Task view: All tasks", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Collapse all tasks", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Search tasks", exact: true })).toHaveValue("");
    await expect(page.getByRole("button", { name: "Filter", exact: true })).toBeVisible();
    await expect(page.locator('.task-list-sort-button[data-active="true"]')).toHaveCount(0);
    await expect(page.getByRole("separator", { name: "Resize sidebar" })).toHaveAttribute("aria-valuenow", "240");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const actual = await page.screenshot({ path: join(evidence!, "reproduction.png"), animations: "disabled", caret: "hide", scale: "css" });
    // Decode both PNGs in the same browser. Compare every RGBA channel exactly,
    // rather than allowing PNG metadata or compression to determine equality.
    const comparison = await page.evaluate(async ({ expected, received }) => {
      const decode = async (base64: string) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height) };
      };
      const left = await decode(expected), right = await decode(received);
      if (left.width !== right.width || left.height !== right.height) throw new Error("Screenshot dimensions differ");
      const canvas = document.createElement("canvas");
      canvas.width = left.width; canvas.height = left.height;
      const context = canvas.getContext("2d")!, diff = context.createImageData(left.width, left.height);
      let changedPixels = 0, maxChannelDelta = 0;
      for (let offset = 0; offset < left.data.data.length; offset += 4) {
        let changed = false;
        for (let channel = 0; channel < 4; channel++) {
          const delta = Math.abs(left.data.data[offset + channel] - right.data.data[offset + channel]);
          changed ||= delta !== 0;
          maxChannelDelta = Math.max(maxChannelDelta, delta);
        }
        if (changed) changedPixels++;
        const gray = Math.round((left.data.data[offset] + left.data.data[offset + 1] + left.data.data[offset + 2]) / 3);
        diff.data[offset] = changed ? 255 : gray;
        diff.data[offset + 1] = changed ? 0 : gray;
        diff.data[offset + 2] = changed ? 0 : gray;
        diff.data[offset + 3] = 255;
      }
      context.putImageData(diff, 0, 0);
      return { width: left.width, height: left.height, changedPixels, totalPixels: left.width * left.height, maxChannelDelta, diffBase64: canvas.toDataURL("image/png").split(",")[1] };
    }, { expected: frozen.toString("base64"), received: actual.toString("base64") });
    const { diffBase64, ...metrics } = comparison;
    writeFileSync(join(evidence!, "difference.png"), Buffer.from(diffBase64, "base64"));
    writeFileSync(join(evidence!, "visual-comparison.json"), JSON.stringify({
      ...metrics, changedPixelRatio: metrics.changedPixels / metrics.totalPixels,
      tolerancePixels: 0, referenceSha256: conditions.sha256,
      reproductionSha256: createHash("sha256").update(actual).digest("hex"),
      referenceConditions: "capture-conditions.json", reproductionUrl: page.url(),
      conditions: { ...conditions, referenceUrl: undefined, frozenAt: undefined, sha256: undefined },
    }, null, 2));
    await testInfo.attach("reproduction", { path: join(evidence!, "reproduction.png"), contentType: "image/png" });
    await testInfo.attach("difference", { path: join(evidence!, "difference.png"), contentType: "image/png" });
    expect(metrics.changedPixels, `Exact pixel comparison: ${JSON.stringify(metrics)}`).toBe(0);
  });

  test("rendered component and source imports audit proves reuse", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.reload();
    await expect(rows(page)).toHaveCount(10);
    const names = await componentNames(page);
    for (const name of ["DesignPageShell", "SidebarShell", "DesignSidebar", "SidebarCompanyMenu", "SidebarAccountMenu", "TaskListToolbar", "IssueFiltersPopover", "TaskList", "TaskListViewport", "TaskListColumnHeader", "TaskListColumnSettings", "TaskRowGroup", "IssueRow", "CellMarquee", "NewIssueDialog", "CommandPalette"]) expect(names).toContain(name);
    expect(names).not.toContain("TaskListPagePreview");
    expect(names).not.toContain("TasksReproductionTrial");
    const controller = readFileSync("ui/storybook/support/design-proposals/TasksReproductionTrial2.tsx", "utf8");
    expect(controller).toMatch(/import\s*\{\s*useTaskListCollection\s*\}\s*from\s*"@\/hooks\/useTaskListCollection"/);
    expect(controller).toMatch(/creators:\s*collection\.creators/);
    expect(controller).toMatch(/issues=\{collection\.matchingItems\.map/);
    expect(controller).not.toMatch(/TaskListPagePreview|TasksReproductionTrial["']|applyIssueFilters|includeTaskListAncestors|matchesTaskListView|createdByAgentId|createdByUserId|toLocaleLowerCase|\.filter\(|style=|<button|<input|<table|<svg|#[0-9a-f]{6}|\[\d+px\]/i);
    await page.getByRole("button", { name: "Board view", exact: true }).click();
    expect(await componentNames(page)).toContain("KanbanBoard");
    const index = await (await page.request.get("/index.json")).json();
    expect(index.entries[storyId].title).toBe("Design proposals/AI Generated Test Pages/Tasks reproduction test 2");
    expect(errors).toEqual([]);
    writeFileSync(join(evidence!, "reuse-audit.json"), JSON.stringify({ storyId, renderedComponents: names, boardComponent: "KanbanBoard", controllerImportsSharedCollection: true, duplicatedCollectionLogicDetected: false, forbiddenCompositionDetected: false, browserErrors: errors }, null, 2));
  });

  test("read/unread hover, nested guides and all expansion levels", async ({ page }, testInfo) => {
    const unread = titles(page).filter({ hasText: /^Improve connector reliability$/ });
    const read = titles(page).filter({ hasText: /^Design reconnect and recovery flows$/ });
    await expect(unread).toHaveCSS("font-weight", "600");
    await expect(read).toHaveCSS("font-weight", "400");
    const foreground = await unread.evaluate(element => getComputedStyle(element).color);
    expect(await read.evaluate(element => getComputedStyle(element).color)).not.toBe(foreground);
    for (const [title, weight] of [[read, "400"], [unread, "600"]] as const) {
      const background = () => title.evaluate(element => getComputedStyle(element.closest('[data-slot="task-row"]')!).backgroundColor);
      const previous = await background();
      const bounds = (await title.boundingBox())!;
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await expect(title).toHaveCSS("color", foreground);
      await expect(title).toHaveCSS("font-weight", weight);
      expect(await background()).not.toBe(previous);
    }
    await page.screenshot({ path: testInfo.outputPath("unread-hover.png"), animations: "disabled" });
    await expect(page.locator('[data-slot="task-row-tree-guide"]')).toHaveCount(5);
    const x = await titles(page).evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x));
    expect(x[1] - x[0]).toBe(24);
    expect(x[3] - x[1]).toBe(24);
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

  test("sorting, column visibility, order, reset and list/board retention", async ({ page }) => {
    await page.getByRole("button", { name: "Task ID: sort ascending", exact: true }).click();
    await expect(page.getByRole("columnheader", { name: "Task ID" })).toHaveAttribute("aria-sort", "ascending");
    await page.getByRole("button", { name: "Task ID: sort descending", exact: true }).click();
    await expect(titles(page).first()).toHaveText("Collect feedback on the refreshed task list");
    await page.getByRole("button", { name: "Columns", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: "Created by", exact: true }).click();
    await expect(page.getByRole("menuitemcheckbox", { name: "Created by", exact: true })).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("columnheader")).toHaveCount(4);
    await page.getByRole("button", { name: "Board view", exact: true }).click();
    await expect(page.getByRole("region", { name: "Task board columns", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "List view", exact: true }).click();
    await expect(page.getByRole("columnheader")).toHaveCount(4);
    await expect(titles(page).first()).toHaveText("Collect feedback on the refreshed task list");
    await page.getByRole("button", { name: "Created by: sort ascending", exact: true }).press("Alt+ArrowLeft");
    await expect(page.getByRole("columnheader")).toHaveText(["Task", "Created by", "Task ID", "Last updated"]);
    await page.getByRole("button", { name: "Columns", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: "Task ID", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("columnheader")).toHaveText(["Task", "Created by", "Last updated"]);
    await expect(page.locator('.task-list-sort-button[data-active="true"]')).toHaveCount(0);
    await page.getByRole("button", { name: "Created by: sort ascending", exact: true }).click();
    await page.getByRole("button", { name: "Columns", exact: true }).click();
    await page.getByRole("menuitem", { name: "Reset defaults", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("columnheader")).toHaveText(["Task", "Task ID", "Last updated"]);
    await expect(page.locator('.task-list-sort-button[data-active="true"]')).toHaveCount(0);
    await expect(titles(page).first()).toHaveText("Improve connector reliability");
  });

  test("all canonical views and saved view selection survive reload", async ({ page }) => {
    await page.getByRole("button", { name: "Task view: All tasks", exact: true }).click();
    await expect(page.getByRole("menuitemradio")).toHaveText(["Inbox", "Unread", "Needs attention", "All tasks"]);
    await page.keyboard.press("Escape");
    for (const [label, count] of [["Inbox", 6], ["Unread", 3], ["Needs attention", 3], ["All tasks", 10]] as const) {
      await selectView(page, label);
      await expect(rows(page)).toHaveCount(count);
      await page.reload();
      await expect(page.getByRole("button", { name: `Task view: ${label}`, exact: true })).toBeVisible();
      await expect(rows(page)).toHaveCount(count);
    }
  });

  test("human and agent creator filtering preserves identity", async ({ page }) => {
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Search projects", exact: true })).toBeVisible();
    const creator = page.getByRole("region", { name: "Creator", exact: true });
    await creator.getByRole("checkbox", { name: "Scott", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(rows(page)).toHaveCount(6);
    await expect(titles(page)).toHaveText(["Improve connector reliability", "Chat style tasks v2", "Refine the empty task-list state", "Simplify the first company setup", "Review budget notifications", "Collect feedback on the refreshed task list"]);
    await page.getByRole("button", { name: "1", exact: true }).click();
    await creator.getByRole("checkbox", { name: "Scott", exact: true }).click();
    await creator.getByRole("checkbox", { name: "CodexCoder", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(rows(page)).toHaveCount(5);
    await expect(page.locator(".design-task-results")).toHaveText("4 matching tasks · Parent tasks included for context");
    await expect(titles(page)).toHaveText(["Improve connector reliability", "Define connector health states", "Design reconnect and recovery flows", /Document connector recovery/, "Review failure messages with the team"]);
  });

  test("collapsed parents reveal children after search, view and filter transitions", async ({ page }) => {
    const collapse = () => page.getByRole("button", { name: "Collapse Improve connector reliability", exact: true });
    const search = page.getByRole("textbox", { name: "Search tasks", exact: true });
    await collapse().click();
    await search.fill("expired credential");
    await expect(rows(page)).toHaveCount(3);
    await expect(titles(page)).toHaveText(["Improve connector reliability", "Design reconnect and recovery flows", /Document connector recovery/]);
    await expect(collapse()).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".design-task-results")).toHaveText("1 matching task · Parent tasks included for context");
    await search.fill("");
    await collapse().click();
    await selectView(page, "Unread");
    await expect(rows(page)).toHaveCount(3);
    await expect(collapse()).toHaveAttribute("aria-expanded", "true");
    await selectView(page, "All tasks");
    await collapse().click();
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await page.getByRole("checkbox", { name: "In Review", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(rows(page)).toHaveCount(3);
    await expect(collapse()).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".design-task-results")).toHaveText("2 matching tasks · Parent tasks included for context");
    await page.getByRole("button", { name: "Board view", exact: true }).click();
    const board = page.locator(".design-task-board");
    await expect(board.getByRole("button")).toHaveCount(2);
    await expect(board.getByText("Define connector health states", { exact: true })).toBeVisible();
    await expect(board.getByText("Review budget notifications", { exact: true })).toBeVisible();
    await expect(board.getByText("Improve connector reliability", { exact: true })).toHaveCount(0);
    await expect(page.locator(".design-task-results")).toHaveText("2 matching tasks");
  });

  test("metadata search covers creator, assignee, project and tags; empty state resets", async ({ page }) => {
    const search = page.getByRole("textbox", { name: "Search tasks", exact: true });
    for (const [query, count, matching] of [["Scott", 6, 6], ["CodexCoder", 8, 8], ["Design", 6, 5], ["Board UI", 9, 9], ["Design system", 3, 2]] as const) {
      await search.fill(query);
      await expect(rows(page), `Metadata query ${query}`).toHaveCount(count);
      await expect(page.locator(".design-task-results")).toContainText(`${matching} matching tasks`);
    }
    await expect(titles(page)).toHaveText(["Improve connector reliability", "Define connector health states", "Review budget notifications"]);
    await search.fill("no such task");
    await expect(page.getByText("No tasks match this view", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    await expect(search).toHaveValue("");
    await expect(rows(page)).toHaveCount(10);
  });

  test("canonical menus, company boundary and sidebar resize persistence", async ({ page }) => {
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
    await page.reload();
    await expect(resize).toHaveAttribute("aria-valuenow", "288");
  });
});

async function openStory(page: Page, id: string) {
  await page.clock.setFixedTime(new Date(clock));
  await page.goto(`/iframe.html?id=${id}&viewMode=story&globals=theme:dark`);
  await expect(page.getByTestId("design-page-shell")).toBeVisible();
  await page.evaluate(async () => {
    await Promise.all([document.fonts.load('400 14px InterVariable'), document.fonts.load('600 14px InterVariable'), document.fonts.load('400 14px "Paper Mono"')]);
    await document.fonts.ready;
  });
  await page.mouse.move(1439, 899);
}

test("freeze reference before implementation", async ({ page, browser }) => {
  test.skip(process.env.TRIAL_2_FREEZE !== "1", "Reference is frozen once, before implementation.");
  expect(existsSync(reference), "Never overwrite the frozen reference").toBe(false);
  await openStory(page, "tasks-list-page-design--default");
  await expect(page.locator('.design-task-list-panel [data-slot="task-row"]')).toHaveCount(10);
  await expect(page.getByRole("columnheader")).toHaveText(["Task", "Task ID", "Last updated"]);
  await expect(page.getByRole("button", { name: "Task view: All tasks", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Collapse all tasks", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Search tasks", exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Filter", exact: true })).toBeVisible();
  await expect(page.getByRole("separator", { name: "Resize sidebar" })).toHaveAttribute("aria-valuenow", "240");
  await expect(page.locator('.task-list-sort-button[data-active="true"]')).toHaveCount(0);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  mkdirSync(evidence!, { recursive: true });
  const png = await page.screenshot({ animations: "disabled", caret: "hide", scale: "css" });
  writeFileSync(reference, png, { flag: "wx" });
  const fonts = await page.evaluate(() => Array.from(document.fonts).filter(font => font.status === "loaded").map(font => ({ family: font.family, weight: font.weight, status: font.status })));
  writeFileSync(join(evidence!, "capture-conditions.json"), JSON.stringify({
    referenceUrl: page.url(), frozenAt: new Date().toISOString(), clock,
    viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1,
    browser: browser.version(), platform: process.platform, colorScheme: "dark",
    reducedMotion: "reduce", locale: "en-US", timezoneId: "America/Los_Angeles",
    fonts, freshIsolatedContext: true, pointer: { x: 1439, y: 899 },
    view: "All tasks", layout: "list", sidebarWidth: 240,
    columns: ["Task", "Task ID", "Last updated"], sort: null, query: "", filters: [],
    hierarchy: "expanded", menus: "closed", sha256: createHash("sha256").update(png).digest("hex"),
  }, null, 2), { flag: "wx" });
});
