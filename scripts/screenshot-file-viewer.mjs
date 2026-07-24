#!/usr/bin/env node
// Screenshots every FileViewerSheet Storybook state at desktop + mobile viewports.

import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const BASE = "http://localhost:6006/iframe.html";
const OUT_DIR = path.resolve(process.argv[2] || "/tmp/pap-1963");

const SHOTS = [
  { id: "components-file-viewer-sheet--text-content-with-highlighted-line", label: "content-highlighted-line" },
  { id: "components-file-viewer-sheet--text-content-long-path-truncation", label: "content-long-path" },
  { id: "components-file-viewer-sheet--open-file-prompt", label: "open-file-prompt" },
  { id: "components-file-viewer-sheet--loading-spinner", label: "loading-spinner" },
  { id: "components-file-viewer-sheet--error-not-found-with-fallback", label: "error-not-found" },
  { id: "components-file-viewer-sheet--error-no-workspace", label: "error-no-workspace" },
  { id: "components-file-viewer-sheet--error-outside-workspace", label: "error-outside-workspace" },
  { id: "components-file-viewer-sheet--error-denied-sensitive", label: "error-denied" },
  { id: "components-file-viewer-sheet--remote-workspace", label: "remote-workspace" },
  { id: "components-file-viewer-sheet--workspace-archived", label: "workspace-archived" },
  { id: "components-file-viewer-sheet--binary-unsupported", label: "binary-unsupported" },
  { id: "components-file-viewer-sheet--too-large-to-preview", label: "too-large" },
];

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

async function run() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const vp of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      for (const shot of SHOTS) {
        const url = `${BASE}?id=${shot.id}&viewMode=story&args=`;
        console.log(`[${vp.name}] → ${shot.label}`);
        await page.goto(url, { waitUntil: "domcontentloaded" });
        // Give the sheet animation + potential network stubs ~1.5s to settle.
        await page.waitForTimeout(shot.label === "loading-spinner" ? 900 : 1600);
        const out = path.join(OUT_DIR, `${vp.name}-${shot.label}.png`);
        await page.screenshot({ path: out, fullPage: false });
      }
      // Extra capture: mobile view story (its own viewport story) as a cross-check.
      if (vp.name === "mobile") {
        await page.goto(
          `${BASE}?id=components-file-viewer-sheet--mobile-view&viewMode=story&args=`,
          { waitUntil: "domcontentloaded" },
        );
        await page.waitForTimeout(1600);
        await page.screenshot({
          path: path.join(OUT_DIR, `mobile-story-variant.png`),
          fullPage: false,
        });
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`\nScreenshots written to ${OUT_DIR}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
