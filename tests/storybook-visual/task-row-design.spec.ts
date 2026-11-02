import { expect, test, type Locator, type Page } from "@playwright/test";

const longTitle = "Document connector recovery behavior when an expired credential interrupts an active task and requires a human to reconnect the account";

test.use({ viewport: { width: 1512, height: 862 } });

function rowFor(page: Page, number: number): Locator {
  return page.locator('[data-slot="task-row"]').filter({
    has: page.getByRole("link", { name: new RegExp(`^Open PAP-${number}:`) }),
  });
}

async function openStory(page: Page, name = "specimen") {
  await page.goto(`/iframe.html?id=tasks-row-design--${name}&viewMode=story&globals=theme:dark`);
  await expect(page.getByTestId("task-row-design-preview")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
}

async function titleOverflows(title: Locator) {
  return title.evaluate(element => element.querySelector('[data-slot="task-row-title-text"]')!.scrollWidth > element.clientWidth);
}

test("playground changes density and width independently without losing hierarchy or title states", async ({ page }, testInfo) => {
  await openStory(page);
  const preview = page.getByTestId("task-row-playground-container");
  const row = preview.locator('[data-slot="task-row"]').first();
  const widths = page.getByRole("group", { name: "Container width", exact: true });
  const densities = page.getByRole("group", { name: "Row density", exact: true });
  for (const { label, height } of [{ label: "Comfortable (44px)", height: "44px" }, { label: "Compact (32px)", height: "32px" }]) {
    await densities.getByRole("button", { name: label, exact: true }).click();
    await expect(densities.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true");
    for (const width of ["Standard", "Narrow", "Smallest"]) {
      await widths.getByRole("button", { name: width, exact: true }).click();
      await expect(widths.getByRole("button", { name: width, exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(preview.locator('[data-slot="task-row"]')).toHaveCount(9);
      await expect(row).toHaveCSS("height", height);
      await expect(row.locator('[data-slot="task-row-identifier"]')).toBeVisible({ visible: width === "Standard" });
      await expect(row.locator('[data-slot="task-row-metadata"]')).toBeVisible({ visible: width === "Standard" });
      await expect(row.locator('[data-slot="task-row-timestamp"]')).toBeVisible({ visible: width !== "Smallest" });
      await expect(rowFor(page, 431).locator('[data-slot="task-row-tree-guide"]')).toHaveCount(2);
      for (const { number, weight } of [{ number: 456, weight: "400" }, { number: 457, weight: "600" }]) {
        const title = rowFor(page, number).locator('[data-slot="task-row-title"]');
        await expect(title).toHaveCSS("font-size", "14px");
        await expect(title).toHaveCSS("line-height", "16px");
        await expect(title).toHaveCSS("font-weight", weight);
      }
      const fit = await preview.evaluate(element => element.scrollWidth <= element.clientWidth);
      expect(fit).toBe(true);
    }
  }
  await page.getByRole("button", { name: "Collapse Improve connector reliability", exact: true }).click();
  await widths.getByRole("button", { name: "Narrow", exact: true }).click();
  await expect(preview.locator('[data-slot="task-row"]')).toHaveCount(5);
  await page.getByRole("button", { name: "Expand Improve connector reliability", exact: true }).click();
  await expect(preview.locator('[data-slot="task-row"]')).toHaveCount(9);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: testInfo.outputPath("task-row-playground.png"), fullPage: true });
});

test("summary rows fit narrow containers without changing density or read typography", async ({ page }, testInfo) => {
  await openStory(page, "summary");
  for (const { label, identifier, timestamp } of [
    { label: "Standard task summary", identifier: true, timestamp: true },
    { label: "Narrow task summary", identifier: false, timestamp: true },
    { label: "Smallest task summary", identifier: false, timestamp: false },
  ]) {
    const list = page.getByRole("list", { name: label, exact: true });
    const rows = list.locator('[data-slot="task-row"]');
    await expect(rows).toHaveCount(3);
    const row = rows.first();
    await expect(row).toHaveCSS("height", "44px");
    await expect(row.locator('[data-slot="task-row-title"]')).toHaveCSS("font-size", "14px");
    await expect(row.locator('[data-slot="task-row-title"]')).toHaveCSS("line-height", "16px");
    await expect(row.locator('[data-slot="task-row-title"]')).toHaveCSS("font-weight", "400");
    await expect(row.locator('[data-slot="task-row-identifier"]')).toBeVisible({ visible: identifier });
    await expect(row.locator('[data-slot="task-row-timestamp"]')).toBeVisible({ visible: timestamp });
    const fit = await list.evaluate(element => ({ content: element.scrollWidth, available: element.clientWidth }));
    expect(fit.content).toBeLessThanOrEqual(fit.available);
    await expect(list.locator('[data-testid="issue-row-unread-slot"], [data-slot="avatar"], [role="columnheader"]')).toHaveCount(0);
  }
  const list = page.getByRole("list", { name: "Narrow task summary", exact: true });
  const row = list.locator('[data-slot="task-row"]').first();
  const title = row.locator('[data-slot="task-row-title"]');
  expect(await titleOverflows(title)).toBe(true);
  const originalColor = await title.evaluate(element => getComputedStyle(element).color);
  const rect = (await title.boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await expect(title).toHaveAttribute("data-revealing", "true");
  await expect(title).toHaveCSS("font-weight", "400");
  expect(await title.evaluate(element => getComputedStyle(element).color)).not.toBe(originalColor);
  await page.mouse.move(0, 0);
  await expect(title).not.toHaveAttribute("data-revealing");
  const link = list.getByRole("link", { name: `Open PAP-431: ${longTitle}`, exact: true });
  await link.focus();
  await expect(title).toHaveAttribute("data-revealing", "true");
  await link.press("Escape");
  await expect(title).not.toHaveAttribute("data-revealing");
  await page.getByRole("heading", { name: "Task summaries", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("task-summary-containers.png"), fullPage: true });
  // Container queries also apply below the app's global sm breakpoint.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(list.locator('[data-slot="task-row-identifier"]').first()).toBeHidden();
  await expect(list.locator('[data-slot="task-row-timestamp"]').first()).toBeVisible();
  await expect(row).toHaveCSS("height", "44px");
  await expect(row.locator('[data-slot="task-row-status"]')).toBeVisible();
});

for (const { story, density, height } of [
  { story: "specimen", density: "comfortable", height: 44 },
  { story: "compact", density: "compact", height: 32 },
]) {
  test(`${density} rows retain nesting, aligned metadata, and one group boundary`, async ({ page }, testInfo) => {
    await openStory(page, story);
    const list = page.locator(`[aria-label="${density} task list"]`);
    const rows = list.locator('[data-slot="task-row"]');
    await expect(rows).toHaveCount(7);
    const geometry = await rows.evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const left = (slot: string) => element.querySelector(`[data-slot="${slot}"]`)!.getBoundingClientRect().left;
      return {
        height: rect.height,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
        titleLeft: left("task-row-title"),
        metadataLeft: left("task-row-metadata"),
        identifierLeft: left("task-row-identifier"),
        timestampLeft: left("task-row-timestamp"),
        borderTop: style.borderTopWidth,
        borderBottom: style.borderBottomWidth,
      };
    }));
    for (const row of geometry) {
      expect(row.height).toBe(height);
      expect(row.paddingLeft).toBe("16px");
      expect(row.paddingRight).toBe("16px");
      expect(row.borderTop).toBe("0px");
      expect(row.borderBottom).toBe("0px");
      expect(row.metadataLeft).toBe(geometry[0].metadataLeft);
      expect(row.identifierLeft).toBe(geometry[0].identifierLeft);
      expect(row.timestampLeft).toBe(geometry[0].timestampLeft);
    }
    expect(geometry[1].titleLeft - geometry[0].titleLeft).toBe(24);
    expect(geometry[2].titleLeft).toBe(geometry[1].titleLeft);
    expect(geometry[3].titleLeft - geometry[2].titleLeft).toBe(24);
    expect(geometry[4].titleLeft).toBe(geometry[1].titleLeft);

    const groups = list.locator('[data-slot="task-row-group"]');
    await expect(groups).toHaveCount(3);
    await expect(groups.first()).toHaveCSS("border-top-width", "1px");
    await expect(groups.first()).toHaveCSS("border-bottom-width", "1px");
    await expect(groups.nth(1)).toHaveCSS("border-top-width", "0px");
    expect((await groups.first().boundingBox())!.height).toBe(height * 5 + 2);

    // The outer guide stays continuous through child and grandchild rows.
    const guides = await Promise.all([429, 430, 431, 432].map(async (number) =>
      rowFor(page, number).locator('[data-slot="task-row-tree-connector"]').first().boundingBox(),
    ));
    for (let index = 0; index < guides.length; index += 1) {
      expect(guides[index]!.x).toBe(guides[0]!.x);
      expect(guides[index]!.height).toBe(height);
      if (index > 0) expect(guides[index - 1]!.y + guides[index - 1]!.height).toBe(guides[index]!.y);
    }
    const depthTwoGuides = await rowFor(page, 431).locator('[data-slot="task-row-tree-connector"]').evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().left));
    expect(depthTwoGuides[1] - depthTwoGuides[0]).toBe(24);
    await expect(rowFor(page, 430).locator('[data-chevron-gap="true"]')).toHaveCount(1);
    if (density === "comfortable") {
      const path = testInfo.outputPath("task-row-specimen.png");
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach("Task row specimen", { path, contentType: "image/png" });
    }
  });
}

test("read and unread preserve their weights through real pointer hover", async ({ page }) => {
  await openStory(page);
  const foreground = await page.getByRole("heading", { name: "Task rows", exact: true }).evaluate((element) => getComputedStyle(element).color);
  const muted = await page.getByText("Read · Regular", { exact: true }).evaluate((element) => getComputedStyle(element).color);
  expect(foreground).not.toBe(muted);
  for (const { number, weight, color } of [
    { number: 456, weight: "400", color: muted },
    { number: 457, weight: "600", color: foreground },
  ]) {
    const row = rowFor(page, number);
    const title = row.locator('[data-slot="task-row-title"]');
    await page.mouse.move(0, 0);
    await expect(title).toHaveCSS("font-weight", weight);
    await expect(title).toHaveCSS("color", color);
    const background = await row.evaluate((element) => getComputedStyle(element).backgroundColor);
    await row.hover();
    await expect(title).toHaveCSS("font-weight", weight);
    await expect(title).toHaveCSS("color", foreground);
    expect(await row.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(background);
    await page.mouse.move(0, 0);
    await expect(title).toHaveCSS("color", color);
  }
  const identifier = rowFor(page, 428).locator('[data-slot="task-row-identifier"]');
  expect(await identifier.evaluate((element) => getComputedStyle(element).fontFamily)).toContain("Paper Mono");
  expect(await page.evaluate(() => document.fonts.check('12px "Paper Mono"'))).toBe(true);
});

test("title reveal follows truncation on resize and respects reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openStory(page);
  const row = rowFor(page, 430);
  const title = row.locator('[data-slot="task-row-title"]');
  const link = row.locator('[data-inbox-issue-link]');
  const text = title.locator('[data-slot="task-row-title-text"]');
  expect(await titleOverflows(title)).toBe(false);
  await link.hover();
  await expect(title).not.toHaveAttribute("data-revealing");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.mouse.move(0, 0);
  await link.focus();
  await expect(link).toBeFocused();
  await expect(title).not.toHaveAttribute("data-revealing");
  await expect(page.getByRole("tooltip")).toHaveCount(0);

  await page.setViewportSize({ width: 660, height: 862 });
  await expect.poll(() => titleOverflows(title)).toBe(true);
  await expect(title).toHaveAttribute("data-revealing", "true");
  await expect(text).toHaveCSS("transition-duration", "0s");
  await expect.poll(async () => Math.abs((await text.boundingBox())!.x + (await text.boundingBox())!.width - (await title.boundingBox())!.x - (await title.boundingBox())!.width)).toBeLessThan(1);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.setViewportSize({ width: 1512, height: 862 });
  await expect.poll(() => titleOverflows(title)).toBe(false);
  await expect(title).not.toHaveAttribute("data-revealing");
  await expect(text).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  await expect(link).toBeFocused();
});

test("all nine columns use sm text and align through nesting and horizontal scrolling", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1200, height: 862 });
  await openStory(page, "all-columns");
  const header = page.locator('[data-slot="task-list-column-header"]');
  await expect(header.locator('[data-column]')).toHaveText([
    "Task", "Task ID", "Created by", "Assignee", "Project", "Parent Task", "Tags", "Worktree", "Last updated",
  ]);
  await expect(header).toHaveCSS("height", "44px");
  const columns = ["taskId", "createdBy", "assignee", "project", "parentTask", "tags", "lastUpdated", "worktree"];
  const rows = page.locator('[data-slot="task-row"]');
  await expect(rows).toHaveCount(7);
  await expect(header.getByRole("button", { name: /^Status:/ })).toHaveCount(0);
  await expect(header.locator('[data-column="task"]')).toHaveAttribute("aria-colspan", "2");
  const typeSizes = await page.locator('[data-slot="task-row-title"], [data-slot="task-row-columns"] [data-column], [data-slot="task-row-columns"] [data-slot="badge"], .task-list-sort-button > span').evaluateAll(elements => elements.map(element => ({ size: getComputedStyle(element).fontSize, leading: getComputedStyle(element).lineHeight })));
  for (const type of typeSizes) expect(type).toEqual({ size: "14px", leading: "16px" });
  for (const column of columns) {
    const heading = await header.locator(`[data-column="${column}"]`).boundingBox();
    const cells = await rows.locator(`[data-column="${column}"]`).evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
    expect(cells).toHaveLength(7);
    for (const cell of cells) {
      expect(cell.x).toBe(heading!.x);
      expect(cell.width).toBe(heading!.width);
    }
  }
  const rootTitle = await rowFor(page, 428).locator('[data-slot="task-row-title"]').boundingBox();
  expect(rootTitle!.x).toBe((await header.locator('[data-column="task"]').getByRole("button").locator("span").boundingBox())!.x);
  for (const number of [428, 429, 431]) {
    const row = rowFor(page, number);
    const status = await row.locator('[data-slot="task-row-status"]').boundingBox();
    const title = await row.locator('[data-slot="task-row-title"]').boundingBox();
    expect(title!.x - status!.x - status!.width).toBe(8);
  }
  expect((await rowFor(page, 431).locator('[data-slot="task-row-title"]').boundingBox())!.x - rootTitle!.x).toBe(48);
  await expect(rowFor(page, 455).locator('[data-column="assignee"]')).toHaveText("Unassigned");
  await expect(rowFor(page, 455).locator('[data-column="worktree"]')).toHaveText("—");
  await expect(rowFor(page, 431).locator('[data-column="parentTask"]')).toContainText("PAP-430");
  await expect(rowFor(page, 428).locator('[data-column="worktree"]')).toHaveText("codex/pap-428");

  const scroller = page.getByRole("region", { name: "Task list columns" });
  const viewport = page.locator('[data-slot="task-list-viewport"]');
  expect(await scroller.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect(viewport).toHaveAttribute("data-overflow-left", "false");
  await expect(viewport).toHaveAttribute("data-overflow-right", "true");
  await scroller.focus();
  await expect(scroller).toBeFocused();
  await scroller.evaluate(element => element.scrollTo({ left: (element.scrollWidth - element.clientWidth) / 2 }));
  await expect(viewport).toHaveAttribute("data-overflow-left", "true");
  await expect(viewport).toHaveAttribute("data-overflow-right", "true");
  await header.locator('[data-column="worktree"]').scrollIntoViewIfNeeded();
  expect(await scroller.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await scroller.evaluate(element => element.scrollTo({ left: element.scrollWidth }));
  await expect(viewport).toHaveAttribute("data-overflow-left", "true");
  await expect(viewport).toHaveAttribute("data-overflow-right", "false");
  await expect(header.locator('[data-column]')).toHaveCount(9);
  await page.setViewportSize({ width: 1700, height: 862 });
  await expect.poll(() => scroller.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false);
  await expect(viewport).toHaveAttribute("data-overflow-left", "false");
  await expect(viewport).toHaveAttribute("data-overflow-right", "false");
  await page.getByRole("heading", { name: "Task-list columns", exact: true }).click();
  const path = testInfo.outputPath("task-list-all-columns.png");
  await page.locator('.task-list-columns-content').screenshot({ path });
  await testInfo.attach("Complete column specimen", { path, contentType: "image/png" });
});

test("headers sort both ways without separating subtasks from their parents", async ({ page }, testInfo) => {
  await openStory(page, "all-columns");
  const header = page.locator('[data-slot="task-list-column-header"]');
  await expect(header.getByRole("button", { name: /^Status:/ })).toHaveCount(0);
  const ids = page.locator('[data-slot="task-row"] [data-column="taskId"]');
  const taskId = header.locator('[data-column="taskId"]');
  await expect(taskId).toHaveAttribute("aria-sort", "none");
  await expect(header.locator('[data-active="true"]')).toHaveCount(0);
  await expect(header.locator('[data-slot="task-list-sort-direction"]')).toHaveCount(0);
  await taskId.getByRole("button").click();
  await expect(taskId).toHaveAttribute("aria-sort", "ascending");
  for (const button of await header.getByRole("button").all()) {
    await expect(button).toHaveCSS("padding-left", "8px");
    await expect(button).toHaveCSS("padding-right", "8px");
  }
  await expect(taskId.locator('[data-slot="task-list-sort-direction"]')).toHaveCSS("width", "12px");
  await expect(taskId.locator('[data-slot="task-list-sort-direction"]')).toHaveCSS("height", "12px");
  await taskId.getByRole("button").click();
  await expect(taskId).toHaveAttribute("aria-sort", "descending");
  await expect(ids).toHaveText(["PAP-455", "PAP-454", "PAP-428", "PAP-432", "PAP-430", "PAP-431", "PAP-429"]);
  await expect(rowFor(page, 431).locator('[data-slot="task-row-tree-guide"]')).toHaveCount(2);
  const collapse = page.getByRole("button", { name: "Collapse Improve connector reliability", exact: true });
  await collapse.click();
  await expect(ids).toHaveText(["PAP-455", "PAP-454", "PAP-428"]);
  await page.getByRole("button", { name: "Expand Improve connector reliability", exact: true }).click();
  await expect(ids).toHaveText(["PAP-455", "PAP-454", "PAP-428", "PAP-432", "PAP-430", "PAP-431", "PAP-429"]);
  await taskId.getByRole("button").focus();
  await page.keyboard.press("Enter");
  await expect(taskId).toHaveAttribute("aria-sort", "ascending");
  await expect(ids).toHaveText(["PAP-428", "PAP-429", "PAP-430", "PAP-431", "PAP-432", "PAP-454", "PAP-455"]);

  const title = header.locator('[data-column="task"]');
  const titleLabel = title.getByRole("button").locator("span");
  const labelBefore = await titleLabel.boundingBox();
  await title.getByRole("button").hover();
  await expect(title.getByRole("button")).toHaveCSS("padding-left", "8px");
  await expect(title.getByRole("button")).toHaveCSS("padding-right", "8px");
  expect(await titleLabel.boundingBox()).toEqual(labelBefore);
  await title.getByRole("button").click();
  await expect(title).toHaveAttribute("aria-sort", "ascending");
  await expect(taskId).toHaveAttribute("aria-sort", "none");
  await expect(ids).toHaveText(["PAP-454", "PAP-428", "PAP-429", "PAP-430", "PAP-431", "PAP-432", "PAP-455"]);
  await title.getByRole("button").click();
  await expect(title).toHaveAttribute("aria-sort", "descending");
  await expect(ids).toHaveText(["PAP-455", "PAP-428", "PAP-432", "PAP-430", "PAP-431", "PAP-429", "PAP-454"]);
  await page.mouse.move(0, 0);
  await expect(title.getByRole("button")).toHaveCSS("background-color", "rgb(51, 51, 51)");
  const path = testInfo.outputPath("task-list-task-header.png");
  await page.locator('[data-slot="task-list-viewport"]').screenshot({ path });
  await testInfo.attach("Combined Task header and sm table typography", { path, contentType: "image/png" });

  for (const column of ["createdBy", "assignee", "project", "parentTask", "tags", "lastUpdated", "worktree"]) {
    const cell = header.locator(`[data-column="${column}"]`);
    await cell.getByRole("button").click();
    await expect(cell).toHaveAttribute("aria-sort", "ascending");
    await expect(cell.locator('[data-slot="task-list-sort-direction"]')).toHaveCSS("width", "12px");
    await expect(cell.locator('[data-slot="task-list-sort-direction"]')).toHaveCSS("height", "12px");
    await cell.getByRole("button").click();
    await expect(cell).toHaveAttribute("aria-sort", "descending");
    await expect(cell.locator('[data-slot="task-list-sort-direction"]')).toHaveCSS("width", "12px");
    await expect(cell.locator('[data-slot="task-list-sort-direction"]')).toHaveCSS("height", "12px");
    await expect(header.locator('[aria-sort="descending"]')).toHaveCount(1);
  }
  // A missing worktree stays last even when sorting descending.
  await expect(ids).toHaveText(["PAP-454", "PAP-428", "PAP-432", "PAP-430", "PAP-431", "PAP-429", "PAP-455"]);
});

test("truncated cells reveal independently and preserve row navigation", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openStory(page, "all-columns");
  const row = rowFor(page, 431);
  const title = row.locator('[data-slot="task-row-title"]');
  const parent = row.locator('[data-column="parentTask"] [data-cell-marquee]');
  const tags = rowFor(page, 429).locator('[data-column="tags"] [data-cell-marquee]');
  const parentText = parent.locator('.cell-marquee-content');
  const revealing = page.locator('[data-cell-marquee][data-revealing="true"]');
  const moveToCell = async (cell: Locator) => {
    const rect = (await cell.boundingBox())!;
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  };
  const overflows = (cell: Locator) => cell.evaluate(element => element.querySelector('.cell-marquee-content')!.scrollWidth > element.clientWidth);
  expect(await overflows(title)).toBe(true);
  expect(await overflows(parent)).toBe(true);
  expect(await overflows(tags)).toBe(true);
  for (const cell of [title, parent, tags]) {
    await expect(cell).toHaveAttribute("data-truncated", "true");
    await expect(cell.locator('.cell-marquee-viewport')).not.toHaveCSS("mask-image", "none");
  }
  const fitting = row.locator('[data-column="taskId"] [data-cell-marquee]');
  await expect(fitting).not.toHaveAttribute("data-truncated");
  await expect(fitting.locator('.cell-marquee-viewport')).toHaveCSS("mask-image", "none");
  const mask = await parent.locator('.cell-marquee-viewport').evaluate(element => getComputedStyle(element).maskImage);
  const background = await row.evaluate(element => getComputedStyle(element).backgroundColor);
  await moveToCell(fitting);
  expect(await row.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(background);
  await expect(parent.locator('.cell-marquee-viewport')).toHaveCSS("mask-image", mask);
  await expect(parent).not.toHaveAttribute("data-revealing");
  await page.locator('[data-slot="task-list-viewport"]').screenshot({ path: testInfo.outputPath("task-list-truncation-fade-hover.png") });
  await page.mouse.move(0, 0);
  await row.locator('[data-inbox-issue-link]').focus();
  await expect(title).toHaveAttribute("data-revealing", "true");
  await moveToCell(parent);
  await expect(parent).toHaveAttribute("data-revealing", "true");
  await expect(title).not.toHaveAttribute("data-revealing");
  await expect(revealing).toHaveCount(1);
  await expect.poll(() => parentText.evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).m41)).toBeLessThan(-1);
  await parentText.evaluate(element => element.getAnimations().forEach(animation => animation.finish()));
  await expect(parent).toHaveAttribute("data-reveal-complete", "true");
  const endMask = await parent.locator('.cell-marquee-viewport').evaluate(element => getComputedStyle(element).maskImage);
  expect(endMask).not.toBe(mask);
  expect(endMask).not.toMatch(/transparent\)$|rgba\(0, 0, 0, 0\)\)$/);
  const parentEnd = await parentText.boundingBox();
  const parentViewport = await parent.boundingBox();
  expect(Math.abs(parentEnd!.x + parentEnd!.width - parentViewport!.x - parentViewport!.width)).toBeLessThan(1);
  await moveToCell(tags);
  await expect(tags).toHaveAttribute("data-revealing", "true");
  await expect(parent).not.toHaveAttribute("data-revealing");
  await expect(parentText).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  await expect(parentText).toHaveCSS("transition-duration", "0s");
  await expect(revealing).toHaveCount(1);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await moveToCell(rowFor(page, 429).locator('[data-column="taskId"]'));
  await expect(revealing).toHaveCount(0);
  await parent.focus();
  await expect(parent).toHaveAttribute("data-revealing", "true");
  await page.keyboard.press("Escape");
  await expect(parent).not.toHaveAttribute("data-revealing");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await moveToCell(parent);
  await expect(parent).toHaveAttribute("data-revealing", "true");
  await expect(parentText).toHaveCSS("transition-duration", "0s");
  const cell = (await row.locator('[data-column="parentTask"]').boundingBox())!;
  await page.mouse.click(cell.x + cell.width / 2, cell.y + cell.height / 2);
  await expect(page.getByTestId("task-row-design-route")).toHaveText("/PAP/issues/PAP-431");
  await page.mouse.move(0, 0);
  await page.screenshot({ path: testInfo.outputPath("task-list-cell-marquees.png") });
});

test("column headers drag in either direction, preserve sorting and nesting, and reset their order", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await openStory(page, "all-columns");
  const header = page.locator('[data-slot="task-list-column-header"]');
  const initialOrder = ["Task", "Task ID", "Created by", "Assignee", "Project", "Parent Task", "Tags", "Worktree", "Last updated"];
  await expect(header.locator('[data-column]')).toHaveText(initialOrder);
  const dragHeader = async (from: string, to: string) => {
    const button = (await header.locator(`[data-column="${from}"] button`).boundingBox())!;
    const target = (await header.locator(`[data-column="${to}"]`).boundingBox())!;
    await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2);
    await page.mouse.down();
    await page.mouse.move(button.x + button.width / 2 + 8, button.y + button.height / 2);
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
    await page.mouse.up();
  };
  await dragHeader("taskId", "assignee");
  await expect(header.locator('[data-column]')).toHaveText(["Task", "Created by", "Assignee", "Task ID", "Project", "Parent Task", "Tags", "Worktree", "Last updated"]);
  await expect(header.locator('[data-column="taskId"]')).toHaveAttribute("aria-sort", "none");
  await dragHeader("task", "project");
  await expect(header.locator('[data-column]')).toHaveText(["Created by", "Assignee", "Task ID", "Project", "Task", "Parent Task", "Tags", "Worktree", "Last updated"]);
  const task = header.locator('[data-column="task"] button');
  await task.focus();
  await page.keyboard.press("Alt+ArrowLeft");
  const movedOrder = ["Created by", "Assignee", "Task ID", "Task", "Project", "Parent Task", "Tags", "Worktree", "Last updated"];
  await expect(header.locator('[data-column]')).toHaveText(movedOrder);
  await expect(task).toBeFocused();
  for (const id of ["createdBy", "assignee", "taskId", "project", "parentTask", "tags", "worktree", "lastUpdated"]) {
    const rect = (await header.locator(`[data-column="${id}"]`).boundingBox())!;
    for (const cell of await page.locator(`[data-slot="task-row"] [data-column="${id}"]`).all()) {
      expect((await cell.boundingBox())!.x).toBe(rect.x);
    }
  }
  const root = rowFor(page, 428);
  const child = rowFor(page, 431);
  expect((await child.locator('[data-slot="task-row-title"]').boundingBox())!.x - (await root.locator('[data-slot="task-row-title"]').boundingBox())!.x).toBe(48);
  for (const row of [root, child]) {
    const status = (await row.locator('[data-slot="task-row-status"]').boundingBox())!;
    expect((await row.locator('[data-slot="task-row-title"]').boundingBox())!.x - status.x - status.width).toBe(8);
  }
  await page.keyboard.press("Enter");
  await expect(header.locator('[data-column="task"]')).toHaveAttribute("aria-sort", "ascending");
  await page.mouse.move(0, 0);
  await expect(task).toHaveCSS("background-color", "rgb(51, 51, 51)");
  await page.locator('[data-slot="task-list-viewport"]').screenshot({ path: testInfo.outputPath("task-list-reordered-columns.png") });
  const settings = page.getByRole("button", { name: "Columns", exact: true });
  await settings.click();
  const menu = page.getByRole("menu", { name: "Columns", exact: true });
  await expect(menu.getByRole("menuitemcheckbox")).toHaveText(movedOrder);
  await menu.getByRole("menuitemcheckbox", { name: "Created by", exact: true }).click();
  await menu.getByRole("menuitemcheckbox", { name: "Created by", exact: true }).click();
  await expect(header.locator('[data-column]')).toHaveText(movedOrder);
  await menu.getByRole("menuitem", { name: "Reset defaults", exact: true }).click();
  await expect(header.locator('[data-column]')).toHaveText(["Task", "Task ID", "Last updated"]);
  await expect(menu.getByRole("menuitemcheckbox")).toHaveText(initialOrder);
  await expect(header.locator('[data-active="true"]')).toHaveCount(0);
  await expect(header.locator('[data-slot="task-list-sort-direction"]')).toHaveCount(0);
  await menu.getByRole("menuitemcheckbox", { name: "Worktree", exact: true }).click();
  await expect(header.locator('[data-column]')).toHaveText(["Task", "Task ID", "Worktree", "Last updated"]);
  await page.keyboard.press("Escape");
  // Drag cancellation must not change the order or toggle sorting.
  const button = (await task.boundingBox())!;
  await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2);
  await page.mouse.down();
  await page.mouse.move(button.x + button.width / 2 + 100, button.y + button.height / 2);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(header.locator('[data-column]')).toHaveText(["Task", "Task ID", "Worktree", "Last updated"]);
  await expect(header.locator('[data-column="task"]')).toHaveAttribute("aria-sort", "none");
});

test("status labels appear on hover and focus while the icon still opens the task", async ({ page }, testInfo) => {
  await openStory(page, "all-columns");
  const status = rowFor(page, 428).locator('[data-slot="task-row-status"]');
  const tooltip = page.getByRole("tooltip");
  await status.hover();
  await expect(tooltip).toHaveText("In Progress");
  await page.mouse.move(0, 0, { steps: 3 });
  await expect(tooltip).toHaveCount(0);
  await status.focus();
  await expect(tooltip).toHaveText("In Progress");
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  await expect(status).toBeFocused();
  await rowFor(page, 429).locator('[data-slot="task-row-status"]').hover();
  await expect(tooltip).toHaveText("In Review");
  const path = testInfo.outputPath("task-status-tooltip.png");
  await page.screenshot({ path });
  await testInfo.attach("Task status label", { path, contentType: "image/png" });
  await status.click();
  await expect(page.getByTestId("task-row-design-route")).toHaveText("/PAP/issues/PAP-428");
});

test("pinned Columns menu hides columns, retains alignment, and resets defaults", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1200, height: 862 });
  await openStory(page, "all-columns");
  const header = page.locator('[data-slot="task-list-column-header"]');
  const settings = page.getByRole("button", { name: "Columns", exact: true });
  const settingsBefore = await settings.boundingBox();
  await page.getByRole("region", { name: "Task list columns" }).evaluate(element => element.scrollTo({ left: element.scrollWidth }));
  expect(await settings.boundingBox()).toEqual(settingsBefore);
  await settings.click();
  const menu = page.getByRole("menu", { name: "Columns", exact: true });
  await expect(menu).toBeVisible();
  // Match the Paper flyout while retaining the current combined Task contract.
  await expect(menu).toHaveCSS("width", "200px");
  await expect(menu).toHaveCSS("border-radius", "8px");
  await expect(menu).toHaveCSS("border-width", "1px");
  await expect(menu).toHaveCSS("border-style", "solid");
  await expect(menu).toHaveCSS("background-color", "rgb(26, 26, 26)");
  const borderColor = await menu.evaluate(element => getComputedStyle(element.querySelector(".task-list-options-heading")!).borderBottomColor);
  await expect(menu).toHaveCSS("border-color", borderColor);
  for (const surface of [page.locator("html"), page.locator("body"), page.locator("#storybook-root"), page.getByTestId("task-row-design-preview"), page.locator('[data-slot="task-list-viewport"]'), page.locator(".task-list-header-controls"), page.locator('[data-slot="task-row-group"]').first()]) {
    await expect(surface).toHaveCSS("background-color", "rgb(26, 26, 26)");
  }
  const heading = menu.locator(".task-list-options-heading");
  await expect(heading).toHaveCSS("padding", "12px 24px");
  await expect(heading).toHaveCSS("font-weight", "600");
  const options = menu.getByRole("menuitemcheckbox");
  const menuGeometry = await options.evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const check = element.querySelector("svg")!.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, size: style.fontSize, leading: style.lineHeight, weight: style.fontWeight, radius: style.borderRadius, checkRight: rect.right - check.right, checkWidth: check.width };
  }));
  for (const [index, item] of menuGeometry.entries()) {
    expect(item).toMatchObject({ width: 174, height: 32, size: "14px", leading: "20px", weight: "400", radius: "4px", checkRight: 12, checkWidth: 14 });
    if (index > 0) expect(item.y - menuGeometry[index - 1].y).toBe(36);
  }
  const reset = menu.getByRole("menuitem", { name: "Reset defaults", exact: true });
  await expect(reset).toHaveCSS("height", "32px");
  await expect(reset).toHaveCSS("font-weight", "600");
  const taskIdOption = menu.getByRole("menuitemcheckbox", { name: "Task ID", exact: true });
  await taskIdOption.hover();
  await expect(taskIdOption).toHaveCSS("background-color", "rgb(51, 51, 51)");
  await expect(taskIdOption).toHaveCSS("color", await heading.evaluate(element => getComputedStyle(element).color));
  await expect(menu.getByRole("menuitemcheckbox")).toHaveCount(9);
  await expect(menu.getByRole("menuitemcheckbox", { name: "Status", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("menuitemcheckbox", { name: "Task", exact: true })).toBeChecked();
  for (const name of ["Created by", "Tags", "Task ID"]) {
    const item = menu.getByRole("menuitemcheckbox", { name, exact: true });
    await expect(item).toBeChecked();
    await item.click();
    await expect(item).not.toBeChecked();
    await expect(menu).toBeVisible();
  }
  await expect(header.locator('[data-column]')).toHaveText(["Task", "Assignee", "Project", "Parent Task", "Worktree", "Last updated"]);
  await expect(page.locator('[data-slot="task-row"] [data-column="tags"]')).toHaveCount(0);
  await expect(header.locator('[data-column="task"]')).toHaveAttribute("aria-sort", "none");
  for (const column of ["assignee", "project", "parentTask", "lastUpdated", "worktree"]) {
    const x = (await header.locator(`[data-column="${column}"]`).boundingBox())!.x;
    const positions = await page.locator(`[data-slot="task-row"] [data-column="${column}"]`).evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x));
    expect(positions).toEqual(Array(7).fill(x));
  }
  // Hiding Task hides both status and title; hierarchy controls and links remain.
  await menu.getByRole("menuitemcheckbox", { name: "Task", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(rowFor(page, 428).locator('[data-slot="task-row-content"]')).toBeHidden();
  await expect(rowFor(page, 428).getByRole("img", { name: "In Progress", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Collapse Improve connector reliability", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Collapse Improve connector reliability", exact: true }).click();
  await expect(rowFor(page, 431)).toHaveCount(0);
  await page.getByRole("button", { name: "Expand Improve connector reliability", exact: true }).click();
  await expect(rowFor(page, 431)).toHaveCount(1);

  await settings.click();
  await menu.getByRole("menuitem", { name: "Reset defaults", exact: true }).click();
  await expect(header.locator('[data-column]')).toHaveText(["Task", "Task ID", "Last updated"]);
  await expect(header.locator('[data-column="taskId"]')).toHaveAttribute("aria-sort", "none");
  await expect(menu.getByRole("menuitemcheckbox", { checked: true })).toHaveText(["Task", "Task ID", "Last updated"]);
  for (const row of await page.locator('[data-slot="task-row"]').all()) {
    expect(await row.locator('[data-column]').evaluateAll(elements => elements.map(element => element.getAttribute("data-column")))).toEqual(["taskId", "lastUpdated"]);
  }
  // Optional columns remain available after resetting to the smaller default.
  const tags = menu.getByRole("menuitemcheckbox", { name: "Tags", exact: true });
  await expect(tags).not.toBeChecked();
  await tags.click();
  await expect(header.locator('[data-column]')).toHaveText(["Task", "Task ID", "Tags", "Last updated"]);
  await expect(page.locator('[data-slot="task-row"] [data-column="tags"] [data-slot="badge"]').first()).toHaveCSS("background-color", "rgb(51, 51, 51)");
  await tags.click();

  // Leave only one column: the final choice is disabled until another is enabled.
  await menu.getByRole("menuitemcheckbox", { name: "Worktree", exact: true }).click();
  for (const name of ["Task", "Task ID", "Last updated"]) {
    await menu.getByRole("menuitemcheckbox", { name, exact: true }).click();
  }
  await expect(menu.getByRole("menuitemcheckbox", { name: "Worktree", exact: true })).toBeDisabled();
  await menu.getByRole("menuitem", { name: "Reset defaults", exact: true }).click();
  await taskIdOption.hover();
  const path = testInfo.outputPath("task-list-options.png");
  await page.screenshot({ path });
  await testInfo.attach("Columns flyout", { path, contentType: "image/png" });
  await menu.screenshot({ path: testInfo.outputPath("task-list-columns-flyout.png") });
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(settings).toBeFocused();
  await expect(rowFor(page, 428).locator('[data-slot="task-row-content"]')).toBeVisible();
  await expect(header.locator('[data-column]')).toHaveText(["Task", "Task ID", "Last updated"]);
  await expect(rowFor(page, 428).locator('[data-column="tags"]')).toHaveCount(0);
  await page.locator('[data-slot="task-list-viewport"]').screenshot({ path: testInfo.outputPath("task-list-default-columns.png") });
});

test("truncated titles scroll once, hold their end, and reset immediately; row actions stay independent", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openStory(page);
  const route = page.getByTestId("task-row-design-route");
  await expect(route).toHaveText("/PAP/storybook");
  const longRow = rowFor(page, 431);
  const title = longRow.locator('[data-slot="task-row-title"]');
  await expect(title).toHaveCSS("text-overflow", "ellipsis");
  await expect(title).toHaveCSS("white-space", "nowrap");
  const text = title.locator('[data-slot="task-row-title-text"]');
  expect(await titleOverflows(title)).toBe(true);
  const start = (await text.boundingBox())!.x;
  const identifierBefore = await longRow.locator('[data-slot="task-row-identifier"]').boundingBox();
  const link = longRow.locator('[data-inbox-issue-link]');
  await link.hover();
  await expect(title).toHaveAttribute("data-revealing", "true");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect.poll(async () => (await text.boundingBox())!.x).toBeLessThan(start - 1);
  expect(await longRow.locator('[data-slot="task-row-identifier"]').boundingBox()).toEqual(identifierBefore);
  await text.evaluate(element => element.getAnimations().forEach(animation => animation.finish()));
  const viewport = await title.boundingBox();
  const end = await text.boundingBox();
  expect(Math.abs(end!.x + end!.width - viewport!.x - viewport!.width)).toBeLessThan(1);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await text.boundingBox()).toEqual(end);
  await page.mouse.move(0, 0);
  await expect(title).not.toHaveAttribute("data-revealing");
  await expect(text).toHaveCSS("transition-duration", "0s");
  expect((await text.boundingBox())!.x).toBe(start);
  await expect(title).toHaveCSS("text-overflow", "ellipsis");

  // Reach the long-title link using the keyboard from the preceding disclosure.
  const childDisclosure = page.getByRole("button", { name: "Collapse Design reconnect and recovery flows" });
  await childDisclosure.focus();
  await page.keyboard.press("Tab");
  await expect(rowFor(page, 430).locator('[data-slot="task-row-status"]')).toBeFocused();
  await expect(page.getByRole("tooltip")).toHaveText("Todo");
  await page.keyboard.press("Tab");
  await expect(link).toBeFocused();
  await expect(title).toHaveAttribute("data-revealing", "true");
  await expect(link).toHaveCSS("outline-style", "solid");
  await expect(link).toHaveCSS("outline-width", "1px");
  await page.keyboard.press("Escape");
  await expect(title).not.toHaveAttribute("data-revealing");

  await childDisclosure.click();
  await expect(rowFor(page, 431)).toHaveCount(0);
  await expect(rowFor(page, 432)).toBeVisible();
  await expect(route).toHaveText("/PAP/storybook");
  await page.getByRole("button", { name: "Expand Design reconnect and recovery flows" }).click();
  await expect(rowFor(page, 431)).toBeVisible();
  await page.getByRole("button", { name: "Collapse Improve connector reliability" }).click();
  await expect(rowFor(page, 429)).toHaveCount(0);
  await expect(rowFor(page, 431)).toHaveCount(0);
  await expect(route).toHaveText("/PAP/storybook");
  const rootDisclosure = page.getByRole("button", { name: "Expand Improve connector reliability" });
  await rootDisclosure.focus();
  await page.keyboard.press("Space");
  await expect(rowFor(page, 431)).toBeVisible();
  await expect(route).toHaveText("/PAP/storybook");
  await rowFor(page, 428).locator('[data-inbox-issue-link]').focus();
  await page.keyboard.press("Enter");
  await expect(route).toHaveText("/PAP/issues/PAP-428");
});
