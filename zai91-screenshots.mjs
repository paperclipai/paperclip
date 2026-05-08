import { chromium } from "@playwright/test";
import fs from "fs";
import path from "path";

const BASE = "http://127.0.0.1:3105";
const PREFIX = "SDF";
const ISSUE_ID = "SDF-1";
const OUT = path.resolve("qa-screenshots-zai91");
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

    // Load base to establish session
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // === Issue detail overview ===
    await page.goto(`${BASE}/${PREFIX}/issues/${ISSUE_ID}`, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
    // Wait for actual content (tabs trigger or issue title heading)
    await page.waitForSelector('[role="tab"]', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await shoot(page, `issue-detail-overview-${lang}`);

    // === Chat/Thread tab (default) — already on it ===
    // Get all visible tabs
    const tabTexts = await page.locator('[role="tab"]').allTextContents();
    console.log(`[${lang}] tabs found:`, tabTexts);

    // Click Activity tab
    const activityTab = page.locator('[role="tab"]').nth(1);
    if (await activityTab.isVisible().catch(() => false)) {
      await activityTab.click();
      await page.waitForTimeout(2000);
      await shoot(page, `issue-detail-activity-${lang}`);
    }

    // Click Related Work tab
    const relatedTab = page.locator('[role="tab"]').nth(2);
    if (await relatedTab.isVisible().catch(() => false)) {
      await relatedTab.click();
      await page.waitForTimeout(2000);
      await shoot(page, `issue-detail-related-work-${lang}`);
    }

    // Go back to chat tab
    const chatTab = page.locator('[role="tab"]').nth(0);
    if (await chatTab.isVisible().catch(() => false)) {
      await chatTab.click();
      await page.waitForTimeout(1000);
    }

    // === Properties panel — click the properties button if visible ===
    // Look for properties/gear button in the top bar
    const propsBtn = page.locator('button[aria-label*="propert" i], button[title*="propert" i]').first();
    if (await propsBtn.isVisible().catch(() => false)) {
      await propsBtn.click();
      await page.waitForTimeout(1500);
      await shoot(page, `issue-detail-properties-panel-${lang}`);
      await propsBtn.click(); // close panel
    } else {
      console.log(`[${lang}] no properties button found`);
    }

    await context.close();
  }

  await browser.close();
  console.log("Done. Screenshots in", OUT);
})();
