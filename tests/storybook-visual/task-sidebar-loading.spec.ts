import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1440, height: 960 }, reducedMotion: "no-preference" });

async function sampleLayout(page: import("@playwright/test").Page, duration: number) {
  return page.evaluate(async (duration) => {
    const samples: Array<{ time: number; pane: number; main: number; skeleton: boolean; overflow: boolean }> = [];
    const start = performance.now();
    while (performance.now() - start < duration) {
      samples.push({
        time: performance.now() - start,
        pane: document.querySelector("aside")!.getBoundingClientRect().width,
        main: document.querySelector("main")!.getBoundingClientRect().width,
        skeleton: Boolean(document.querySelector('[data-testid="issue-chat-skeleton"]')),
        overflow: document.documentElement.scrollWidth > innerWidth,
      });
      await new Promise(requestAnimationFrame);
    }
    return samples;
  }, duration);
}

for (const scenario of ["sidebar-during-skeleton", "sidebar-after-content"]) {
  test(`${scenario} moves the thread with the arriving sidebar`, async ({ page }) => {
    await page.goto(`/iframe.html?id=tasks-sidebar-loading--${scenario}&viewMode=story`);
    const pane = page.locator("aside");
    await expect.poll(() => pane.evaluate((el) => el.getBoundingClientRect().width)).toBe(434);
    await page.getByRole("button", { name: "Replay cold load" }).click();
    await expect(pane).toHaveAttribute("inert", "");
    const samples = await sampleLayout(page, 3000);
    // Route cleanup removes the old pane immediately, before the delayed arrival.
    expect(samples.filter((sample) => sample.time < 700).every((sample) => sample.pane === 0)).toBe(true);
    const reveal = samples.filter((sample) => sample.time > 700 && sample.pane > 2 && sample.pane < 432);
    expect(reveal.length).toBeGreaterThan(0);
    expect(reveal.some((sample) => sample.skeleton)).toBe(scenario === "sidebar-during-skeleton");
    for (const sample of samples) {
      expect(Math.abs(sample.main + sample.pane - 1440)).toBeLessThan(2);
      expect(sample.overflow).toBe(false);
    }
    await expect.poll(() => pane.evaluate((el) => el.getBoundingClientRect().width)).toBe(434);
    await expect(pane).not.toHaveAttribute("inert");
  });
}

for (const scenario of ["without-sidebar", "hidden-sidebar"]) {
  test(`${scenario} leaves the full thread width available`, async ({ page }) => {
    await page.goto(`/iframe.html?id=tasks-sidebar-loading--${scenario}&viewMode=story`);
    await expect(page.getByRole("button", { name: "Replay cold load" })).toBeVisible();
    const samples = await sampleLayout(page, 2700);
    expect(samples.every((sample) => sample.pane === 0 && sample.main === 1440)).toBe(true);
    await expect(page.locator("aside")).toHaveAttribute("inert", "");
    if (scenario === "hidden-sidebar") {
      await page.getByRole("button", { name: "Show sidebar" }).click();
      await expect.poll(() => page.locator("aside").evaluate((el) => el.getBoundingClientRect().width)).toBe(434);
    }
  });
}

test("reduced motion reveals the sidebar without a transition", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/iframe.html?id=tasks-sidebar-loading--sidebar-during-skeleton&viewMode=story");
  await expect(page.getByRole("button", { name: "Replay cold load" })).toBeVisible();
  const samples = await sampleLayout(page, 2700);
  expect(samples.every((sample) => sample.pane === 0 || sample.pane === 434)).toBe(true);
  await expect.poll(() => page.locator("aside").evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
});

test("resizing stays immediate and maximize restores the docked width", async ({ page }) => {
  await page.goto("/iframe.html?id=tasks-sidebar-loading--sidebar-during-skeleton&viewMode=story");
  const pane = page.locator("aside");
  await expect.poll(() => pane.evaluate((el) => el.getBoundingClientRect().width)).toBe(434);
  const grip = page.getByRole("separator", { name: "Resize panel" });
  const bounds = (await grip.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 - 90, bounds.y + bounds.height / 2);
  await expect.poll(() => pane.evaluate((el) => el.getBoundingClientRect().width)).toBe(524);
  expect(await pane.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
  await page.mouse.up();
  await page.getByRole("button", { name: "Maximize side panel" }).click();
  await expect.poll(() => pane.evaluate((el) => el.getBoundingClientRect().width)).toBe(1440);
  await page.getByRole("button", { name: "Restore side panel" }).click();
  await expect.poll(() => pane.evaluate((el) => el.getBoundingClientRect().width)).toBe(524);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
});

test("a viewport narrowed during loading clamps the sidebar before reveal", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("taskChatRedesign.taskDetailPropertiesPaneWidth", "700"));
  await page.goto("/iframe.html?id=tasks-sidebar-loading--sidebar-during-skeleton&viewMode=story&args=sidebarDelay:3500;contentDelay:4500");
  await page.getByRole("button", { name: "Replay cold load" }).click();
  const pane = page.locator("aside");
  await expect.poll(() => pane.evaluate((el) => el.getBoundingClientRect().width)).toBe(0);
  await page.setViewportSize({ width: 1000, height: 960 });
  await expect.poll(() => pane.evaluate((el) => el.getBoundingClientRect().width), { timeout: 8000 }).toBe(344);
  expect(await page.evaluate(() => localStorage.getItem("taskChatRedesign.taskDetailPropertiesPaneWidth"))).toBe("700");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1000);
});

test("removing maximized content releases the empty pane immediately", async ({ page }) => {
  await page.goto("/iframe.html?id=tasks-sidebar-loading--sidebar-during-skeleton&viewMode=story");
  const pane = page.locator("aside");
  await expect.poll(() => pane.evaluate((el) => el.getBoundingClientRect().width)).toBe(434);
  await page.getByRole("button", { name: "Maximize side panel" }).click();
  await expect.poll(() => pane.evaluate((el) => el.getBoundingClientRect().width)).toBe(1440);
  await page.getByRole("button", { name: "Replay cold load" }).click();
  await expect(pane).toHaveAttribute("inert", "");
  const samples = await sampleLayout(page, 500);
  expect(samples.filter((sample) => sample.pane !== 0 || sample.main !== 1440 || sample.overflow)).toEqual([]);
  await expect(pane).toHaveAttribute("inert", "");
  expect(await pane.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
});
