import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");
const addon = require.resolve("@storybook/addon-a11y/package.json", { paths: [resolve(root, "ui")] });
const axePath = require.resolve("axe-core/axe.min.js", { paths: [addon] });
const index = JSON.parse(readFileSync(resolve(root, "ui/storybook-static/index.json"), "utf8"));
const stories = (Object.values(index.entries) as { id: string; type: string }[]).filter((entry) => entry.type === "story" && entry.id.startsWith("connections-speko-"));
async function protectStoryOrigin(page: Page, baseURL: string, external: string[]) {
  const storyOrigin = new URL(baseURL).origin;
  await page.route(/^https?:\/\//, (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== storyOrigin) {
      external.push(url.hostname);
      return route.abort();
    }
    return route.fallback();
  });
}

test("Speko network isolation permits hosted Storybook and blocks providers", async ({ page }) => {
  const baseURL = "https://storybook.example.invalid";
  const external: string[] = [];
  const served: string[] = [];
  await page.route(/^https?:\/\//, (route) => {
    served.push(route.request().url());
    return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Hosted fixture</title>" });
  });
  await protectStoryOrigin(page, baseURL, external);
  await page.goto(`${baseURL}/iframe.html`);
  await expect(page).toHaveTitle("Hosted fixture");
  expect(external).toEqual([]);
  expect(await page.evaluate(async (origin) => (await fetch(`${origin}/asset`)).ok, baseURL)).toBe(true);
  expect(await page.evaluate(async () => {
    try { await fetch("https://api.speko.dev/v1/calls"); return false; }
    catch { return true; }
  })).toBe(true);
  expect(external).toEqual(["api.speko.dev"]);
  expect(served).toEqual([`${baseURL}/iframe.html`, `${baseURL}/asset`]);
});

for (const story of stories) for (const theme of ["light", "dark"]) for (const width of [390, 1200]) {
  test(`Speko accessibility ${story.id} ${theme} ${width}`, async ({ page }, info) => {
    const errors: string[] = [], external: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await protectStoryOrigin(page, info.project.use.baseURL!, external);
    await page.addInitScript(() => {
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: () => { throw new Error("Story attempted real microphone access"); } });
    });
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/iframe.html?id=${story.id}&viewMode=story&globals=theme:${theme}`);
    await expect(page.locator("#storybook-root")).not.toBeEmpty({ timeout: 15_000 });
    await expect(page.locator(".sb-errordisplay")).not.toBeVisible();
    // Storybook's play function exercises the actual controls and controller.
    await page.waitForFunction((id) => document.body.dataset.spekoStoryReady === id, story.id);
    expect(await page.locator("body").getAttribute("data-speko-story-error")).toBeNull();
    if (story.id === "connections-speko-call-history--keyboard-disclosure") {
      const summary = page.locator("#storybook-root summary");
      await summary.press("Enter");
      await expect(page.getByRole("link", {name: "Conversation task", exact: true})).toBeVisible();
      await summary.press("Enter");
      await expect(page.getByRole("link", {name: "Conversation task", exact: true})).not.toBeVisible();
    }
    await page.evaluate(() => document.fonts.ready);
    await page.addScriptTag({ path: axePath });
    let violations: unknown[] = [];
    // The addon also scans after play. Wait for that scan rather than racing
    // its shared axe instance; retry only the explicit concurrent-run signal.
    await expect.poll(async () => page.evaluate(async () => {
      try {
      const result = await (window as any).axe.run({ include: ["#storybook-root", "[role=dialog]"] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
      return { complete: true, violations: result.violations.map((v: any) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n: any) => n.target) })) };
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Axe is already running")) return { complete: false, violations: [] };
        throw error;
      }
    }).then((result) => { violations = result.violations; return result.complete; })).toBe(true);
    expect(violations).toEqual([]);
    expect(errors).toEqual([]); expect(external).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${story.id}-${theme}-${width}.png`), fullPage: true });
  });
}
