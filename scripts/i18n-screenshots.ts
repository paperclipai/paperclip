/**
 * Capture Before (English) / After (Korean) screenshots for i18n PR.
 *
 * Usage:
 *   npx playwright test scripts/i18n-screenshots.ts --config scripts/i18n-screenshots.config.ts
 *   — OR simply —
 *   npx tsx scripts/i18n-screenshots.ts
 */
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3100";
const OUT = path.join(import.meta.dirname ?? __dirname, "../i18n-screenshots");

const PAGES = [
  { name: "dashboard", path: "/" },
  { name: "agents", path: "/agents" },
  { name: "issues", path: "/issues" },
  { name: "projects", path: "/projects" },
  { name: "routines", path: "/routines" },
  { name: "goals", path: "/goals" },
  { name: "costs", path: "/costs" },
  { name: "approvals", path: "/approvals" },
  { name: "settings-general", path: "/settings/general" },
];

async function run() {
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ headless: true });

  for (const lang of ["en", "ko"] as const) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: lang === "ko" ? "ko-KR" : "en-US",
    });
    const page = await context.newPage();

    // Set language preference in localStorage before navigating
    await page.addInitScript((lng: string) => {
      localStorage.setItem("paperclip.language", lng);
    }, lang);

    for (const pg of PAGES) {
      await page.goto(`${BASE}${pg.path}`, { waitUntil: "networkidle", timeout: 30_000 });
      // Small delay for any animations / lazy renders
      await page.waitForTimeout(1000);

      const filename = `${lang}_${pg.name}.png`;
      await page.screenshot({ path: path.join(OUT, filename), fullPage: false });
      console.log(`  captured: ${filename}`);
    }

    await context.close();
  }

  await browser.close();
  console.log(`\nAll screenshots saved to ${OUT}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
