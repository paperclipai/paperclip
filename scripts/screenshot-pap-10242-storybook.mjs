#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const playwrightPkgRoot = path.join(repoRoot, "node_modules/.pnpm/playwright@1.58.2/node_modules/playwright");
const { chromium } = await import(path.join(playwrightPkgRoot, "index.mjs"));

const BASE = process.env.SB_BASE ?? "http://127.0.0.1:6099";
const outDir = path.join(repoRoot, "screenshots/PAP-10242");
await fs.mkdir(outDir, { recursive: true });

const PREFIX = "surfaces-team-catalog";
const desktop = [
  ["browse-list", "01-browse"],
  ["detail-pane", "02-detail"],
  ["install-target-manager", "03-install-target-manager"],
  ["install-source-policy", "04-install-source-policy"],
  ["install-skill-plan", "05-install-skill-plan"],
  ["install-preview", "06-install-preview"],
  ["install-preview-blocked", "07-install-blocked"],
  ["install-apply-progress", "08-apply-progress"],
  ["install-success", "09-success"],
];
const mobile = [
  ["detail-pane", "mobile-detail"],
  ["install-preview", "mobile-install-preview"],
];

const browser = await chromium.launch({
  executablePath: "/srv/paperclip/home/.cache/ms-playwright/chromium-1223/chrome-linux/chrome",
  args: ["--no-sandbox"],
});
const captured = [];
try {
  async function capture(viewport, theme, jobs, suffix) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    for (const [storyId, slug] of jobs) {
      const url = `${BASE}/iframe.html?id=${PREFIX}--${storyId}&viewMode=story&globals=theme:${theme}`;
      await page.goto(url, { waitUntil: "networkidle" }).catch(() => {});
      await page.waitForTimeout(900);
      const target = path.join(outDir, `${slug}-${theme}${suffix}.png`);
      await page.screenshot({ path: target, fullPage: true });
      captured.push(path.basename(target));
      console.log("captured", path.basename(target));
    }
    await context.close();
  }

  await capture({ width: 1440, height: 900 }, "light", desktop, "");
  await capture({ width: 1440, height: 900 }, "dark", [["detail-pane", "02-detail"], ["install-preview", "06-install-preview"]], "");
  await capture({ width: 390, height: 844 }, "light", mobile, "");
} finally {
  await browser.close();
}
console.log(`\n${captured.length} screenshots written to screenshots/PAP-10242/`);
