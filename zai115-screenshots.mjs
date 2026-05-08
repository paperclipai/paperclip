import { chromium } from "@playwright/test";
import fs from "fs";
import path from "path";

const BASE = "http://127.0.0.1:3105";
const PREFIX = "SDF";
const OUT = path.resolve("qa-screenshots-zai115");
fs.mkdirSync(OUT, { recursive: true });

async function shoot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log("wrote", file);
  return file;
}

(async () => {
  const browser = await chromium.launch();

  for (const lang of ["en", "ru"]) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      storageState: {
        cookies: [],
        origins: [
          {
            origin: BASE,
            localStorage: [{ name: "paperclip_language", value: lang }],
          },
        ],
      },
    });
    const page = await context.newPage();

    // Load the base URL to establish session
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 20000 }).catch(() => {});

    // === inbox/mine ===
    await page.goto(`${BASE}/${PREFIX}/inbox/mine`, { waitUntil: "networkidle", timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await shoot(page, `inbox-mine-${lang}`);

    // === keyboard shortcuts dialog ===
    // Dispatch '?' keydown directly to document to trigger the shortcut listener
    await page.click("body");
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(2000);
    await shoot(page, `keyboard-shortcuts-${lang}`);
    // close dialog with Escape
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    // === sidebar agents section ===
    // Navigate to a page that shows the sidebar
    await page.goto(`${BASE}/${PREFIX}/inbox/mine`, { waitUntil: "networkidle", timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    // Take a viewport screenshot (not full page) to capture sidebar
    const sidebarFile = path.join(OUT, `sidebar-agents-${lang}.png`);
    await page.screenshot({ path: sidebarFile, fullPage: false });
    console.log("wrote", sidebarFile);

    await context.close();
  }

  await browser.close();
  console.log("Done. Screenshots in", OUT);
})();
