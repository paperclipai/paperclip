import { expect, test, type Page } from "@playwright/test";

// BUG-04: the queued/steering strip above the task composer grew without a
// height bound. With several long queued messages it covered the transcript,
// pushed the Coordinator dock past the top of the thread and clipped against
// the page chrome. These cases render the production dock and strip.

type LayoutCase = {
  name: string;
  story: string;
  width: number;
  height: number;
  theme?: "dark";
};

const CASES: LayoutCase[] = [
  { name: "desktop", story: "coordinator-dock-queued-messages--many-queued-messages", width: 1245, height: 760 },
  { name: "desktop dark", story: "coordinator-dock-queued-messages--many-queued-messages-dark", width: 1245, height: 760, theme: "dark" },
  { name: "short desktop window", story: "coordinator-dock-queued-messages--many-queued-messages", width: 1024, height: 600 },
  { name: "very short desktop window", story: "coordinator-dock-queued-messages--many-queued-messages", width: 1024, height: 420 },
  { name: "narrow phone", story: "coordinator-dock-queued-messages--many-queued-messages-phone", width: 390, height: 700 },
];

async function renderStory(page: Page, layout: LayoutCase) {
  await page.setViewportSize({ width: layout.width, height: layout.height });
  const globals = layout.theme ? `&globals=theme:${layout.theme}` : "";
  await page.goto(`/iframe.html?id=${layout.story}&viewMode=story${globals}`, { waitUntil: "load" });
  await page.waitForFunction(() => {
    const body = document.body;
    return body.classList.contains("sb-show-main") || body.classList.contains("sb-show-errordisplay");
  });
  expect(await page.locator(".sb-show-errordisplay").count(), `story ${layout.story} threw during render`).toBe(0);
  await expect(page.getByTestId("task-chat-queued-messages")).toBeVisible({ timeout: 15_000 });
  // Let the dock's ResizeObserver publish its measured height.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function box(page: Page, testId: string) {
  const rect = await page.getByTestId(testId).first().boundingBox();
  expect(rect, `${testId} should be rendered`).not.toBeNull();
  return rect!;
}

for (const layout of CASES) {
  test(`queued messages stay bounded inside the composer dock (${layout.name})`, async ({ page }) => {
    await renderStory(page, layout);

    const header = await box(page, "story-task-header");
    const thread = await box(page, "task-chat-thread");
    const dock = await box(page, "task-chat-composer-dock");
    const strip = await box(page, "task-chat-queued-messages");

    // The dock stays inside the thread: it never rides over the task header.
    expect(dock.y, "composer dock overlaps the task header").toBeGreaterThanOrEqual(header.y + header.height - 1);
    expect(dock.y, "composer dock escapes the top of the thread").toBeGreaterThanOrEqual(thread.y - 1);
    expect(dock.y + dock.height, "composer dock is clipped by the viewport").toBeLessThanOrEqual(layout.height + 1);

    // The strip takes at most a bounded share of the thread so the
    // conversation stays readable; the remaining queue scrolls inside it.
    expect(strip.height, "queued strip covers the conversation").toBeLessThanOrEqual(thread.height * 0.4);

    const scroll = await page.getByTestId("task-chat-queued-messages").evaluate((element) => {
      const list = element.querySelector<HTMLElement>("[data-testid=task-chat-queued-messages-list]") ?? element;
      return { scrollHeight: list.scrollHeight, clientHeight: list.clientHeight, overflowY: getComputedStyle(list).overflowY };
    });
    expect(scroll.scrollHeight, "every queued message is reachable").toBeGreaterThan(scroll.clientHeight);
    expect(["auto", "scroll"], "queued list scrolls instead of clipping").toContain(scroll.overflowY);

    // The last queued row and its Steer action are reachable by scrolling the strip.
    const lastSteer = page.getByTestId("task-chat-queued-steer-queued-8");
    await lastSteer.scrollIntoViewIfNeeded();
    const steerBox = (await lastSteer.boundingBox())!;
    const stripAfter = await box(page, "task-chat-queued-messages");
    expect(steerBox.y).toBeGreaterThanOrEqual(stripAfter.y - 1);
    expect(steerBox.y + steerBox.height).toBeLessThanOrEqual(stripAfter.y + stripAfter.height + 1);

    // With the transcript scrolled to the end, the latest message is visible
    // above the dock rather than hidden under it.
    await page.getByTestId("task-chat-scroller").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const latest = await box(page, "story-latest-message");
    const dockAfter = await box(page, "task-chat-composer-dock");
    expect(latest.y + latest.height, "latest transcript message is covered by the dock").toBeLessThanOrEqual(dockAfter.y + 1);
    expect(latest.y, "latest transcript message is pushed above the thread").toBeGreaterThanOrEqual(thread.y - 1);
  });
}

test("queued messages still reorder by drag inside the scrolling list", async ({ page }) => {
  await renderStory(page, CASES[0]);
  const rowOrder = () => page.locator("[data-testid^=task-chat-queued-message-]").evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-testid")!.replace("task-chat-queued-message-", "")));
  expect((await rowOrder()).slice(0, 3)).toEqual(["queued-1", "queued-2", "queued-3"]);

  const handle = page.getByRole("button", { name: /^Reorder queued message: Before you continue/ });
  const from = (await handle.boundingBox())!;
  const to = (await page.getByTestId("task-chat-queued-message-queued-3").boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 8, { steps: 4 });
  await page.mouse.move(from.x + from.width / 2, to.y + to.height / 2 + 4, { steps: 12 });
  await page.mouse.up();

  await expect.poll(async () => (await rowOrder()).slice(0, 3)).toEqual(["queued-2", "queued-3", "queued-1"]);
});
