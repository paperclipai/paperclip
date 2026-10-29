import { test, expect, type Page } from "@playwright/test";
async function story(page: Page, id: string, args = "", theme = "dark") {
  await page.goto(`/iframe.html?id=agents-personas--${id}&viewMode=story&globals=theme:${theme}${args ? `&args=${args}` : ""}`);
  await page.locator("#storybook-root").waitFor();
  await expect.poll(() => page.locator("#storybook-root").evaluate(element => element.childElementCount)).toBeGreaterThan(0);
}
async function imagesLoaded(page: Page) {
  await page.locator("#storybook-root img").evaluateAll(images => images.forEach(image => image.setAttribute("loading", "eager")));
  await expect.poll(() => page.locator("#storybook-root img").evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
}
for (const theme of ["light", "dark"]) {
  for (const id of ["palettes", "sizes", "expressions", "app-placements", "gray-before-connection"]) {
    test(`${id} on ${theme}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await story(page, id, "", theme); await imagesLoaded(page);
      expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
      await expect(page.locator("canvas")).toHaveCount(0);
      await expect(page.locator("#storybook-root")).toHaveScreenshot(`${id}-${theme}.png`, { animations: "disabled", maxDiffPixels: 0 });
    });
  }
}
test("500 avatars load images without WebGL, live modules or avatar frame loops", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    (window as any).__personaProbe = { webgl: 0, frames: 0 };
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind: string, ...args: any[]) {
      if (kind.includes("webgl")) (window as any).__personaProbe.webgl++;
      return (getContext as any).call(this, kind, ...args);
    } as any;
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = callback => {
      if (/\/(runtime|renderer)-/.test(new Error().stack ?? "")) (window as any).__personaProbe.frames++;
      return raf(callback);
    };
  });
  const liveDownloads: string[] = [];
  page.on("request", req => { if (/\/(runtime|renderer)-[^/]+\.js/.test(req.url())) liveDownloads.push(req.url()); });
  await story(page, "five-hundred-static-avatars"); await imagesLoaded(page);
  await expect(page.locator("#storybook-root img")).toHaveCount(500);
  await expect(page.locator("canvas")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__personaProbe)).toEqual({ webgl: 0, frames: 0 });
  expect(liveDownloads).toEqual([]);
});
test("image failures and slow cold responses preserve dimensions", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/agent-avatar-images/**", async route => { await held; await route.abort(); });
  await story(page, "cache-miss-loading");
  const image = page.locator("#storybook-root img");
  const before = await image.boundingBox();
  expect(before?.width).toBe(64); expect(before?.height).toBe(64);
  release();
  await expect(page.locator("#storybook-root")).toContainText("CS");
  const fallback = page.locator("#storybook-root span").filter({ hasText: /^CS$/ }).first();
  expect((await fallback.boundingBox())?.width).toBe(64);
});
test("one live renderer and static fallback after context loss", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await story(page, "one-live-renderer");
  await expect(page.locator("canvas")).toHaveCount(1);
  await story(page, "render-failure");
  await expect(page.locator("canvas")).toHaveCount(1);
  await page.getByRole("button", { name: "Simulate WebGL loss" }).click();
  await expect(page.locator("canvas")).toHaveCount(0); await imagesLoaded(page);
});
test("repeated mounting releases the WebGL canvas", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await story(page, "mount-and-unmount");
  for (let i = 0; i < 3; i++) {
    await expect(page.locator("canvas")).toHaveCount(1);
    await page.getByRole("button", { name: "Toggle character" }).click();
    await expect(page.locator("canvas")).toHaveCount(0);
    await page.getByRole("button", { name: "Toggle character" }).click();
  }
});
const snapshotCases = [
  ...[16, 24, 48, 256].flatMap(size => [1, 2].map(density => ({ size, density, state: "rest" }))),
  ...["idle", "listening", "thinking", "working", "success", "confused", "sleepy", "loading"].map(state => ({ size: 128, density: 2, state })),
];
for (const { size, density, state } of snapshotCases) {
    test(`front-facing SVG and WebGL ${state} at ${size}px density ${density}`, async ({ browser, baseURL }) => {
      const context = await browser.newContext({ deviceScaleFactor: density, reducedMotion: "reduce", baseURL });
      const page = await context.newPage();
      await story(page, "snapshot-agreement", `size:${size};state:${state};density:${density}`); await imagesLoaded(page);
      await expect(page.locator("canvas")).toHaveCount(1);
      await expect(page.locator("#storybook-root")).toHaveScreenshot(`snapshot-pair-${size}-${density}-${state}.png`, { scale: "device", maxDiffPixels: 0 });
      // Same transparent silhouette. Small antialiasing differences are expected
      // between sharp's SVG rasterizer and WebGL's multisample rasterizer.
      const difference = await page.evaluate(async () => {
        const image = document.querySelector('#storybook-root img') as HTMLImageElement;
        const live = document.querySelector('#live-frame canvas, [data-testid="live-frame"] canvas') as HTMLCanvasElement;
        const width = live.width, height = live.height;
        const a = document.createElement("canvas"); a.width = width; a.height = height;
        const b = document.createElement("canvas"); b.width = width; b.height = height;
        const ac = a.getContext("2d")!, bc = b.getContext("2d")!;
        ac.drawImage(image, 0, 0, width, height); bc.drawImage(live, 0, 0, width, height);
        const aa = ac.getImageData(0, 0, width, height).data, bb = bc.getImageData(0, 0, width, height).data;
        let silhouette = 0, colorError = 0, opaque = 0;
        for (let i = 0; i < aa.length; i += 4) {
          if ((aa[i + 3] > 128) !== (bb[i + 3] > 128)) silhouette++;
          if (aa[i + 3] > 240 && bb[i + 3] > 240) { for (let c = 0; c < 3; c++) colorError += Math.abs(aa[i + c] - bb[i + c]); opaque++; }
        }
        return { silhouette: silhouette / (width * height), meanColorError: colorError / (opaque * 3) };
      });
      expect(difference.silhouette).toBeLessThan(0.04);
      expect(difference.meanColorError).toBeLessThan(20);
      await context.close();
    });
}

const fullPages = ["all-agents", "agent-overview", "task", "company-dashboard", "meet-your-next-agent", "new-agent-connection"];
for (const id of fullPages) {
  test(`full app page: ${id}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.clock.setFixedTime(new Date("2026-09-10T18:00:00Z"));
    await page.goto(`/iframe.html?id=agents-personas-full-pages--${id}&viewMode=story&globals=theme:dark`);
    await expect(page.locator("main")).toBeVisible();
    await expect(page.locator("main")).not.toContainText("This page hit an error");
    await expect(page.locator('img[src*="/agent-avatar-images/"]').first()).toBeAttached();
    if (id === "company-dashboard") await expect(page.getByText("Live now", { exact: true })).toBeVisible();
    await imagesLoaded(page);
    await expect(page.locator("canvas")).toHaveCount(0);
    await expect(page).toHaveScreenshot(`full-page-${id}.png`, { animations: "disabled", maxDiffPixels: 0 });
  });
}
for (const density of [1, 2]) {
  test(`onboarding supersamples and stays inside the canvas at density ${density}`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: density, reducedMotion: "no-preference", baseURL });
    const page = await context.newPage();
    await page.goto("/iframe.html?id=agents-personas-full-pages--meet-your-next-agent&viewMode=story");
    await expect(page.locator("canvas")).toHaveCount(1);
    const canvas = page.locator("canvas");
    const dimensions = await canvas.evaluate(c => ({ pixels: (c as HTMLCanvasElement).width, display: c.getBoundingClientRect().width }));
    expect(dimensions.display).toBe(192);
    expect(dimensions.pixels).toBe(dimensions.display * density * 2);
    for (const [x, y] of [[5, 5], [1195, 5], [1195, 895], [5, 895]]) {
      await page.mouse.move(x, y);
      // Let gaze settle at each page corner, well outside the character region.
      await page.waitForTimeout(350);
      const edgeAlpha = await canvas.evaluate(c => {
        const source = c as HTMLCanvasElement;
        const copy = document.createElement("canvas"); copy.width = source.width; copy.height = source.height;
        const ctx = copy.getContext("2d")!; ctx.drawImage(source, 0, 0);
        const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data;
        let maximum = 0;
        for (let y = 0; y < copy.height; y++) for (let x = 0; x < copy.width; x++) {
          if (x < 2 || y < 2 || x >= copy.width - 2 || y >= copy.height - 2) maximum = Math.max(maximum, pixels[(y * copy.width + x) * 4 + 3]);
        }
        return maximum;
      });
      expect(edgeAlpha).toBe(0);
    }
    await context.close();
  });
}
