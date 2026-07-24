#!/usr/bin/env node
/* eslint-disable no-console */
const path = require("path");
const fs = require("fs");

const repoRoot = path.resolve(__dirname, "..");
const playwright = require(path.join(
  repoRoot,
  "node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js",
));

const STORYBOOK_BASE = process.env.STORYBOOK_URL ?? "http://localhost:6006";
const OUT_DIR = path.resolve(repoRoot, "tmp/pap-9134-recovery-screens");

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

const STORIES = [
  {
    id: "paperclip-source-issue-recovery--recovery-action-card-states",
    label: "card-states",
  },
  {
    id: "paperclip-source-issue-recovery--inbox-row-chips",
    label: "inbox-rows",
  },
  {
    id: "paperclip-source-issue-recovery--blocker-notice-recovery-indicators",
    label: "blocker-notice",
  },
  {
    id: "paperclip-source-issue-recovery--active-run-panel-recovery-chips",
    label: "active-run-panel",
  },
];

const THEMES = [
  { name: "light", apply: () => document.documentElement.classList.remove("dark") },
  { name: "dark", apply: () => document.documentElement.classList.add("dark") },
];

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await playwright.chromium.launch();
  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 2,
      });
      for (const story of STORIES) {
        for (const theme of THEMES) {
          const page = await context.newPage();
          const url = `${STORYBOOK_BASE}/iframe.html?id=${story.id}&viewMode=story`;
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
          await page.evaluate((darkTheme) => {
            const html = document.documentElement;
            if (darkTheme) {
              html.classList.add("dark");
            } else {
              html.classList.remove("dark");
            }
          }, theme.name === "dark");
          await page.waitForTimeout(400);
          const outPath = path.join(
            OUT_DIR,
            `${story.label}_${viewport.name}_${theme.name}.png`,
          );
          await page.screenshot({ path: outPath, fullPage: true });
          console.log(`Saved ${outPath}`);
          await page.close();
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
