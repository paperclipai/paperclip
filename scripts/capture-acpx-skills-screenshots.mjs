#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const playwrightPkgRoot = path.join(repoRoot, "node_modules/.pnpm/playwright@1.58.2/node_modules/playwright");
const { chromium } = await import(path.join(playwrightPkgRoot, "index.mjs"));

const baseUrl = process.env.STORYBOOK_BASE_URL ?? "http://127.0.0.1:6007";
const outDir = process.env.OUT_DIR ?? path.join(repoRoot, "screenshots/pap-2999");
await fs.mkdir(outDir, { recursive: true });

const stories = [
  { id: "adapters-acpx-local--skills-tab-claude", slug: "skills-claude" },
  { id: "adapters-acpx-local--skills-tab-codex", slug: "skills-codex" },
  { id: "adapters-acpx-local--skills-tab-custom", slug: "skills-custom" },
  { id: "adapters-acpx-local--skills-tab-loading", slug: "skills-loading" },
  { id: "adapters-acpx-local--skills-tab-empty-library", slug: "skills-empty-library" },
];

const themes = [
  { name: "light", apply: false },
  { name: "dark", apply: true },
];

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
  const page = await context.newPage();
  for (const story of stories) {
    for (const theme of themes) {
      const url = `${baseUrl}/iframe.html?args=&id=${story.id}&viewMode=story&globals=theme:${theme.name}`;
      await page.goto(url, { waitUntil: "load" });
      await page.waitForTimeout(1500);
      const target = path.join(outDir, `${story.slug}-${theme.name}.png`);
      await page.screenshot({ path: target, fullPage: true });
      console.log(`captured ${target}`);
    }
  }
} finally {
  await browser.close();
}
