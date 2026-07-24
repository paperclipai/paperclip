#!/usr/bin/env node
// Screenshot the PAP-13112 "Edit a copy" fork-flow stories.
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const OUT = process.argv[2] || "screenshots/pap-13112";
const BASE = "http://localhost:6006/iframe.html";
await fs.mkdir(path.resolve(OUT), { recursive: true });

const shots = [
  { id: "skill-studio-editacopy--read-only-banner-cta", name: "01-readonly-banner-cta", w: 560, h: 260 },
  { id: "skill-studio-editacopy--fork-dialog-agents-switch-on", name: "02-fork-dialog-switch-on", w: 720, h: 640 },
  { id: "skill-studio-editacopy--fork-dialog-agents-switch-on", name: "03-fork-dialog-switch-off", w: 720, h: 640, toggleOff: true },
  { id: "skill-studio-editacopy--fork-dialog-no-agents", name: "04-fork-dialog-no-agents", w: 720, h: 560 },
  { id: "skill-studio-editacopy--fork-dialog-existing-copy", name: "05-fork-dialog-existing-copy", w: 720, h: 700 },
  { id: "skill-studio-editacopy--forked-skill-header", name: "06-lineage-chip", w: 720, h: 200 },
  { id: "skill-studio-editacopy--project-scan-source-notice", name: "07-project-scan-notice", w: 620, h: 200 },
];

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  for (const shot of shots) {
    const ctx = await browser.newContext({
      viewport: { width: shot.w, height: shot.h },
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    await page.goto(`${BASE}?id=${shot.id}&viewMode=story`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    if (shot.toggleOff) {
      const toggle = page.locator('button[aria-label="Switch these agents to the copy"]');
      await toggle.click();
      await page.waitForTimeout(400);
    }
    const out = path.join(OUT, `${shot.name}.png`);
    await page.screenshot({ path: out, fullPage: false });
    console.log(`Wrote ${out}`);
    await ctx.close();
  }
} finally {
  await browser.close();
}
