#!/usr/bin/env node
// Screenshot the C3 per-item verdict card stories (PAP-13249) at both
// viewports and both themes against a served storybook-static (see PAP-13249).
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const BASE = "http://localhost:6102/iframe.html";
const PREFIX = "chat-comments-issue-thread-interactions";
const OUT_DIR = process.argv[2] || "screenshots/pap-13249";

const stories = [
  { id: "item-verdicts-pending", label: "s1-s2-pending" },
  { id: "item-verdicts-partial", label: "s4-partial" },
  { id: "item-verdicts-complete", label: "s5-complete" },
  { id: "item-verdicts-superseded", label: "s6-superseded" },
  { id: "item-verdicts-many-items", label: "s7-many" },
];
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];
const themes = ["light", "dark"];

await fs.mkdir(path.resolve(OUT_DIR), { recursive: true });
const executablePath = process.env.CHROME_BIN || undefined;
const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ["--no-sandbox", "--headless=new"],
});
try {
  for (const vp of viewports) {
    for (const theme of themes) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 2,
      });
      const page = await ctx.newPage();
      for (const story of stories) {
        const url = `${BASE}?id=${PREFIX}--${story.id}&viewMode=story&globals=theme:${theme}`;
        await page.goto(url, { waitUntil: "networkidle" });
        await page.waitForTimeout(800);
        const out = path.join(OUT_DIR, `${story.label}_${vp.name}_${theme}.png`);
        await page.screenshot({ path: out, fullPage: true });
        console.log(`Wrote ${out}`);
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
