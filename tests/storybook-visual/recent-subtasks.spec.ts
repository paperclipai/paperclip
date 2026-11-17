import { expect, test, type Page } from "@playwright/test";

const states = ["expanded", "collapsed", "exactly-ten", "more-than-ten", "all-subtasks", "selected-subtask", "selected-beyond-ten", "mixed-statuses", "independent-groups", "long-titles", "narrow", "no-subtasks", "empty-recents", "loading", "load-failed", "no-children-available", "keyboard-focus", "section-collapsed", "parent-unread-children-read", "classic"];
async function open(page: Page, state: string, theme = "dark") {
  await page.goto(`/iframe.html?id=design-recent-subtasks--${state}&viewMode=story&globals=theme:${theme}`);
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    __STORYBOOK_ADDONS_CHANNEL__?: { data: Record<string, Array<{ status?: string }>> };
  }).__STORYBOOK_ADDONS_CHANNEL__?.data.storyFinished?.[0]?.status), { timeout: 60_000 }).toBeDefined();
  const outcome = await page.evaluate(() => {
    const result = (window as unknown as { __STORYBOOK_ADDONS_CHANNEL__?: { data: { storyFinished?: Array<{ status: string; reporters?: Array<{ result?: { violations?: Array<{ id: string; nodes: Array<{ target: string[] }> }> } }> }> } } }).__STORYBOOK_ADDONS_CHANNEL__?.data.storyFinished?.[0];
    return { status: result?.status, violations: result?.reporters?.flatMap(reporter => reporter.result?.violations?.map(violation => ({ id: violation.id, targets: violation.nodes.map(node => node.target) })) ?? []) };
  });
  expect(outcome).toMatchObject({ status: "success" });
}

for (const theme of ["light", "dark"]) {
  for (const state of states) test(`${state} in ${theme}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await open(page, state, theme);
    if (!["collapsed", "empty-recents", "no-subtasks", "section-collapsed", "loading", "load-failed", "no-children-available", "independent-groups"].includes(state)) {
      const children = page.getByRole("group", { name: "Subtasks of Ship the project workspace", exact: true });
      if (state !== "long-titles") await expect(children.getByRole("link")).toHaveCount(state === "all-subtasks" ? 14 : ["exactly-ten", "more-than-ten", "selected-beyond-ten"].includes(state) ? 10 : 3);
    }
    if (state === "selected-beyond-ten") await expect(page.getByRole("link", { name: /Subtask 12/ })).toHaveAttribute("aria-current", "page");
    if (state === "more-than-ten") await expect(page.getByRole("button", { name: "Show more (4) · 4 unread" })).toBeVisible();
    if (state === "collapsed") await expect(page.getByRole("button", { name: "3 subtasks · 2 unread", exact: true })).toBeVisible();
    if (state === "parent-unread-children-read") {
      await expect(page.getByRole("link", { name: /Ship the project workspace/ }).getByLabel("Unread")).toHaveCount(1);
      await expect(page.getByRole("group", { name: "Subtasks of Ship the project workspace" }).getByLabel("Unread")).toHaveCount(0);
    }
    if (state === "narrow" || state === "all-subtasks") {
      const overflow = await page.locator(".design-sidebar-recent-list").evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, height: element.clientHeight, scrollHeight: element.scrollHeight }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.width);
      if (state === "all-subtasks") expect(overflow.scrollHeight).toBeGreaterThan(overflow.height);
    }
    expect(errors).toEqual([]);
    await page.locator(".coordinator-workspace").screenshot({ path: testInfo.outputPath(`${state}-${theme}.png`), animations: "disabled" });
  });
}

test("fold, keyboard, overflow and parent navigation preserve personal unread state", async ({ page }) => {
  await open(page, "more-than-ten");
  const group = page.getByRole("group", { name: "Subtasks of Ship the project workspace" });
  const parent = page.getByRole("link", { name: /Ship the project workspace/ });
  await expect(parent).toHaveCount(1);
  await expect(parent.getByLabel("Unread")).toHaveCount(0);
  const url = page.url();
  const collapse = page.getByRole("button", { name: "Collapse subtasks of Ship the project workspace", exact: true });
  await collapse.focus();
  await collapse.press("Enter");
  await expect(page.getByRole("button", { name: "14 subtasks · 13 unread", exact: true })).toBeVisible();
  expect(page.url()).toBe(url);
  await page.getByRole("button", { name: "Expand subtasks of Ship the project workspace", exact: true }).press("Space");
  await expect(group.getByRole("link")).toHaveCount(10);
  await page.getByRole("button", { name: /Show more/ }).click();
  await expect(group.getByRole("link")).toHaveCount(14);
  await expect(group.getByLabel("Unread")).toHaveCount(13);
  await page.getByRole("button", { name: "Show less", exact: true }).click();
  await expect(group.getByRole("link")).toHaveCount(10);
  await expect(page.getByRole("button", { name: "Show more (4) · 4 unread" })).toBeVisible();
  await expect(parent).toHaveAttribute("href", "/PAP/issues/PAP-100");
  await parent.click();
  await expect(group.getByLabel("Unread")).toHaveCount(9);
});

for (const theme of ["light", "dark"]) test(`parent status icons align with leaves and the child guide, with the fold control on the right in ${theme}`, async ({ page }) => {
  for (const state of ["expanded", "collapsed", "narrow", "parent-unread-children-read"]) {
    await open(page, state, theme);
    const parent = page.getByRole("link", { name: /Ship the project workspace/ });
    const leaf = page.getByRole("link", { name: /Review the company dashboard/ });
    const parentIcon = await parent.locator('[data-slot="sidebar-nav-icon"]').boundingBox();
    const leafIcon = await leaf.locator('[data-slot="sidebar-nav-icon"]').boundingBox();
    const parentBounds = await parent.boundingBox();
    const fold = await page.getByRole("button", { name: /^(Collapse|Expand) subtasks of Ship/ }).boundingBox();
    expect(parentIcon).not.toBeNull();
    expect(leafIcon).not.toBeNull();
    expect(Math.abs(parentIcon!.x - leafIcon!.x)).toBeLessThanOrEqual(0.5);
    expect(fold!.x).toBeGreaterThanOrEqual(parentBounds!.x + parentBounds!.width);
    if (state !== "collapsed") {
      const guide = await page.getByRole("group", { name: "Subtasks of Ship the project workspace", exact: true }).boundingBox();
      expect(Math.abs(guide!.x + 0.5 - (parentIcon!.x + parentIcon!.width / 2))).toBeLessThanOrEqual(0.5);
    }
  }
});

test("Classic parent actions remain separate from the right fold control", async ({ page }) => {
  await open(page, "classic");
  const parent = page.getByRole("link", { name: /Ship the project workspace/ });
  const leaf = page.getByRole("link", { name: /Review the company dashboard/ });
  expect((await parent.boundingBox())!.x).toBe((await leaf.boundingBox())!.x);
  const fold = page.getByRole("button", { name: "Collapse subtasks of Ship the project workspace", exact: true });
  const menu = page.getByRole("button", { name: "More actions for Ship the project workspace", exact: true });
  await parent.hover();
  await expect(menu).toBeVisible();
  const menuBounds = (await menu.boundingBox())!;
  const foldBounds = (await fold.boundingBox())!;
  expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(foldBounds.x);
  const url = page.url();
  await menu.click();
  await expect(page.getByRole("menuitem", { name: "Rename", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await fold.click();
  await expect(page.getByRole("button", { name: "Expand subtasks of Ship the project workspace", exact: true })).toHaveAttribute("aria-expanded", "false");
  expect(page.url()).toBe(url);
});
