#!/usr/bin/env node
// Screenshot a single story id at desktop 1440x900.
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const [, , storyId, out, widthArg, heightArg, waitArg] = process.argv;
const width = Number(widthArg) || 1440;
const height = Number(heightArg) || 900;
const waitMs = Number(waitArg) || 2500;
const url = `http://localhost:6006/iframe.html?id=${storyId}&viewMode=story`;

await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(waitMs);
  await page.screenshot({ path: out, fullPage: false });
} finally {
  await browser.close();
}
console.log(`Wrote ${out}`);
