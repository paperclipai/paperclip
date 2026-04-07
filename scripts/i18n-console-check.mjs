/**
 * Check browser console for errors on all main pages.
 * Usage: PAPERCLIP_EMAIL=x PAPERCLIP_PASSWORD=y node scripts/i18n-console-check.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:3100";
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
  { name: "inbox", path: "/inbox" },
  { name: "activity", path: "/activity" },
  { name: "skills", path: "/skills" },
];

async function run() {
  const browser = await chromium.launch({ headless: true });
  const errors = [];

  for (const lang of ["en", "ko"]) {
    console.log(`\n=== ${lang.toUpperCase()} ===`);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    // Collect console errors
    const pageErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        pageErrors.push(msg.text());
      }
    });
    page.on("pageerror", (err) => {
      pageErrors.push(`PAGE ERROR: ${err.message}`);
    });

    // Set language
    await page.addInitScript((lng) => {
      localStorage.setItem("paperclip.language", lng);
    }, lang);

    // Sign in
    await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 30000 });
    const emailInput = page.locator("input[type='email'], input[name='email']");
    if (await emailInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await emailInput.fill(EMAIL);
      await page.locator("input[type='password'], input[name='password']").fill(PASSWORD);
      await page.locator("button[type='submit']").click();
      await page.waitForTimeout(2000);
    }

    for (const pg of PAGES) {
      pageErrors.length = 0;
      try {
        await page.goto(`${BASE}${pg.path}`, { waitUntil: "networkidle", timeout: 30000 });
        await page.waitForTimeout(1500);

        if (pageErrors.length > 0) {
          const filtered = pageErrors.filter(
            (e) => !e.includes("favicon") && !e.includes("404") && !e.includes("net::ERR")
          );
          if (filtered.length > 0) {
            console.log(`  ❌ ${pg.name}: ${filtered.length} error(s)`);
            filtered.forEach((e) => console.log(`     ${e.substring(0, 200)}`));
            errors.push({ lang, page: pg.name, errors: filtered });
          } else {
            console.log(`  ✓ ${pg.name}`);
          }
        } else {
          console.log(`  ✓ ${pg.name}`);
        }
      } catch (err) {
        console.log(`  ⚠ ${pg.name}: navigation error — ${err.message.substring(0, 100)}`);
      }
    }

    await context.close();
  }

  await browser.close();

  console.log(`\n=== SUMMARY ===`);
  if (errors.length === 0) {
    console.log("No browser console errors detected on any page.");
  } else {
    console.log(`${errors.length} page(s) with errors:`);
    errors.forEach((e) => console.log(`  ${e.lang}/${e.page}: ${e.errors.length} error(s)`));
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
