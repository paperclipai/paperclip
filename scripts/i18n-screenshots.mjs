/**
 * Capture Before (English) / After (Korean) screenshots for i18n PR.
 * Usage: node scripts/i18n-screenshots.mjs
 */
import { chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL ?? "http://localhost:3100";
const OUT = path.join(__dirname, "../i18n-screenshots");

const EMAIL = process.env.PAPERCLIP_EMAIL ?? "";
const PASSWORD = process.env.PAPERCLIP_PASSWORD ?? "";

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

async function signIn(page) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 30000 });

  // Check if on login page
  const emailInput = page.locator("input[type='email'], input[name='email']");
  if (await emailInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log("  Signing in...");
    await emailInput.fill(EMAIL);
    await page.locator("input[type='password'], input[name='password']").fill(PASSWORD);
    await page.locator("button[type='submit']").click();
    await page.waitForTimeout(3000);
    console.log("  Signed in");
  } else {
    console.log("  Already signed in");
  }
}

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });

  for (const lang of ["en", "ko"]) {
    console.log(`\n=== Capturing ${lang.toUpperCase()} screenshots ===`);

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: lang === "ko" ? "ko-KR" : "en-US",
    });
    const page = await context.newPage();

    // Set language preference in localStorage
    await page.addInitScript((lng) => {
      localStorage.setItem("paperclip.language", lng);
    }, lang);

    // Sign in with existing account
    await signIn(page);

    for (const pg of PAGES) {
      try {
        await page.goto(`${BASE}${pg.path}`, { waitUntil: "networkidle", timeout: 30000 });
        await page.waitForTimeout(1500);

        const filename = `${lang}_${pg.name}.png`;
        await page.screenshot({ path: path.join(OUT, filename), fullPage: false });
        console.log(`  captured: ${filename}`);
      } catch (err) {
        console.error(`  FAILED: ${lang}_${pg.name} — ${err.message}`);
      }
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
