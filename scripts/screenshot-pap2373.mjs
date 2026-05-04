import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { argv } from "node:process";

const outDir = argv[2] ?? "/tmp/paperclip/pap-2373-stalled-blocker-screens";
const baseUrl = argv[3] ?? "http://localhost:6610";
await mkdir(outDir, { recursive: true });

const id = "foundations-status-language--full-matrix";
const runs = [
  { name: "desktop-1440x900-light", w: 1440, h: 900, theme: "light" },
  { name: "desktop-1440x900-dark", w: 1440, h: 900, theme: "dark" },
  { name: "mobile-390x844-light", w: 390, h: 844, theme: "light" },
  { name: "mobile-390x844-dark", w: 390, h: 844, theme: "dark" },
];

const browser = await chromium.launch();
try {
  for (const run of runs) {
    const url = `${baseUrl}/iframe.html?id=${id}&viewMode=story&globals=theme:${run.theme}`;
    const context = await browser.newContext({
      viewport: { width: run.w, height: run.h },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForTimeout(1500);
    const file = `${outDir}/${run.name}.png`;
    await page.screenshot({ path: file, fullPage: true });
    console.log("wrote", file);
    await context.close();
  }
} finally {
  await browser.close();
}
