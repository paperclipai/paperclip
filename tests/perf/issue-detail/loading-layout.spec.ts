import fs from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { richLoadingFixture, type RichLoadingFixture } from "./rich-loading-fixture";

type Box = { x: number; y: number; width: number; height: number };
type Font = { family: string; size: string; lineHeight: string; weight: string };
type Frame = { time: number; ready: boolean; visibleHeader: boolean; loading: Box | null; latest: Box | null; scrollHeight?: number; loadingComposer: Box | null; composer: Box | null; loadingFont: Font | null; titleFont: Font | null; identifier: Box | null; identifierFont: Font | null };

test.use({ video: "on", trace: "retain-on-failure", serviceWorkers: "block", colorScheme: "dark" });
test.setTimeout(60_000);
test.skip(!process.env.PAPERCLIP_ISSUE_PERF_DATABASE_URL, "The rich loading fixture requires disposable PostgreSQL");

let fixture: RichLoadingFixture;
test.beforeAll(async ({ request }) => { fixture = await richLoadingFixture(request); });

for (const entry of ["direct", "list", "delayed fonts", "delayed preferences"] as const) for (const mobile of [false, true]) test(`a rich task reveals once without flashing its header or moving its reading position (${entry}, ${mobile ? "mobile" : "desktop"})`, async ({ page }, info) => {
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 });
  await page.route("**/api/workspace-preferences/me", async route => {
    if (entry === "delayed preferences") await new Promise(resolve => setTimeout(resolve, 2500));
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), coordinatorWorkspaceEnabled: true } });
  });
  if (entry === "delayed fonts") await page.route("**/*.woff2", async route => {
    await new Promise(resolve => setTimeout(resolve, 2500));
    await route.continue();
  });
  await page.addInitScript(() => {
    const frames: Frame[] = [];
    Object.assign(window, { loadingLayoutFrames: frames });
    const sample = () => {
      const loading = document.querySelector('[data-testid="task-chat-loading-frame"]');
      const ready = document.querySelector('[data-testid="task-chat-thread"] > [aria-busy="false"]');
      const scroller = document.querySelector('[data-testid="task-chat-scroller"]');
      const last = [...document.querySelectorAll('[id^="comment-"]')].at(-1);
      const identifier = [...document.querySelectorAll('[data-slot="task-title-identifier"]')].find(el => {
        const rect = el.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= 76 && getComputedStyle(el).visibility === "visible";
      });
      const visibleHeader = [...document.querySelectorAll('[data-testid="issue-detail-header"]')].some(el => {
        const rect = el.getBoundingClientRect();
        return getComputedStyle(el).visibility === "visible" && rect.bottom > 60 && rect.top < innerHeight;
      });
      const box = (el: Element | null | undefined) => {
        if (!el || getComputedStyle(el).visibility !== "visible") return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      };
      const font = (el: Element | null) => {
        if (!el) return null;
        const style = getComputedStyle(el);
        return { family: style.fontFamily, size: style.fontSize, lineHeight: style.lineHeight, weight: style.fontWeight };
      };
      frames.push({ time: performance.now(), ready: !!ready, visibleHeader, loading: box(loading), latest: box(last), scrollHeight: scroller?.scrollHeight,
        loadingComposer: box(document.querySelector('[data-testid="task-chat-loading-composer"] .paperclip-task-chat-composer')),
        composer: box(document.querySelector('[data-testid="task-chat-composer-stack"] .paperclip-task-chat-composer')),
        loadingFont: font(document.querySelector('[data-slot="task-loading-title"]')),
        titleFont: font(document.querySelector('[data-testid="task-chat-history-content"] [data-testid="issue-detail-header"] h2')),
        identifier: box(identifier), identifierFont: font(identifier ?? null),
      });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 80, downloadThroughput: 1179648, uploadThroughput: 196608 });
  if (entry === "list") {
    await page.goto(`/${fixture.prefix}/issues`);
    await page.locator("[data-inbox-issue-link]").filter({ hasText: fixture.title }).first().click();
  } else {
    await page.goto(`/${fixture.prefix}/issues/${fixture.identifier}`);
  }
  await expect(page.getByTestId("task-chat-thread").locator(':scope > [aria-busy="false"]')).toBeVisible();
  await expect(page.getByTestId("task-chat-composer-stack").locator('[contenteditable="true"]')).toBeEditable();
  await expect(page.getByRole("button", { name: "Approve patch", exact: true })).toBeVisible();
  await expect(page.getByText("Latest investigation findings", { exact: true })).toBeAttached();
  await page.waitForTimeout(500);
  const frames = await page.evaluate(() => (window as unknown as { loadingLayoutFrames: Frame[] }).loadingLayoutFrames);
  await fs.writeFile(info.outputPath("frames.json"), JSON.stringify({ frames }, null, 2));
  expect(frames.filter(frame => !frame.ready && frame.visibleHeader)).toEqual([]);
  const loadingFrames = frames.filter(frame => frame.loading);
  expect(loadingFrames.length).toBeGreaterThan(2);
  for (const dimension of ["x", "y", "width", "height"] as const) {
    const values = loadingFrames.map(frame => frame.loading![dimension]);
    expect(Math.max(...values) - Math.min(...values), `loading frame ${dimension}`).toBeLessThanOrEqual(2);
  }
  const visibleComposers = loadingFrames.filter(frame => frame.loadingComposer);
  expect(visibleComposers.length).toBeGreaterThan(2);
  for (const dimension of ["x", "y", "width", "height"] as const) {
    const values = visibleComposers.map(frame => frame.loadingComposer![dimension]);
    expect(Math.max(...values) - Math.min(...values), `loading composer ${dimension}`).toBeLessThanOrEqual(2);
  }
  const revealed = frames.filter(frame => frame.ready && frame.latest);
  expect(revealed.length).toBeGreaterThan(5);
  expect(Math.max(...revealed.map(frame => frame.latest!.y)) - Math.min(...revealed.map(frame => frame.latest!.y))).toBeLessThanOrEqual(2);
  expect(new Set(revealed.map(frame => frame.scrollHeight)).size).toBe(1);
  const lastLoading = loadingFrames.at(-1)!;
  expect(lastLoading.loadingFont).toEqual(revealed[0].titleFont);
  expect(Math.abs(lastLoading.loadingComposer!.y - revealed[0].composer!.y)).toBeLessThanOrEqual(2);
  expect(Math.abs(lastLoading.loadingComposer!.height - revealed[0].composer!.height)).toBeLessThanOrEqual(2);
  const identifiers = frames.filter(frame => frame.identifier);
  expect(identifiers.length).toBeGreaterThan(2);
  expect(new Set(identifiers.map(frame => JSON.stringify(frame.identifierFont))).size).toBe(1);
  for (const dimension of ["x", "y", "width", "height"] as const) {
    const values = identifiers.map(frame => frame.identifier![dimension]);
    expect(Math.max(...values) - Math.min(...values), `breadcrumb identifier ${dimension}`).toBeLessThanOrEqual(2);
  }
  await page.screenshot({ path: info.outputPath("ready.png") });
});
