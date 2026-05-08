/**
 * BBA Selector Doctor — non-destructive canary script.
 * Verifies that key Casa Pariurilor selectors are alive before a real betting run.
 * Usage: node scripts/bba-selector-doctor.mjs
 * Output: JSON report + writes ~/.paperclip/bba-selector-health.json
 */
import { chromium } from "playwright";
import fs from "fs/promises";
import os from "os";
import path from "path";

const COOKIE_CACHE = path.join(os.homedir(), ".paperclip", "bba-cookie-cache.json");
const HEALTH_FILE  = path.join(os.homedir(), ".paperclip", "bba-selector-health.json");
const CASA_BASE    = "https://www.casapariurilor.ro";
const FOTBAL_URL   = `${CASA_BASE}/pariuri-online/fotbal`;
const LOGIN_BTN    = ".header-login-wrapper.user-box-link";

const results = [];

function check(name, status, selector, url, note) {
  results.push({ name, status, selector: selector ?? null, url: url ?? null, note: note ?? null });
}

const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "ro-RO" });

// Inject cookies
try {
  const cached = JSON.parse(await fs.readFile(COOKIE_CACHE, "utf8"));
  if (Array.isArray(cached?.cookies) && cached.cookies.length > 0) {
    await ctx.addCookies(cached.cookies);
    check("cookie-cache", "ok", null, null, `${cached.cookies.length} cookies loaded`);
  } else {
    check("cookie-cache", "warn", null, null, "cookie cache empty");
  }
} catch {
  check("cookie-cache", "fail", null, null, "cookie cache missing — run bba-login.mjs first");
}

const page = await ctx.newPage();

// 1. Login check
await page.goto(CASA_BASE, { waitUntil: "domcontentloaded", timeout: 30_000 });
await page.waitForTimeout(3_000);
const loginVisible = await page.locator(LOGIN_BTN).isVisible({ timeout: 5_000 }).catch(() => true);
check(
  "session-active",
  loginVisible ? "fail" : "ok",
  LOGIN_BTN,
  CASA_BASE,
  loginVisible ? "CONECTARE button visible — session expired" : "logged in",
);

// 2. Navigate to /fotbal
await page.goto(FOTBAL_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
await page.waitForTimeout(2_000);
check("fotbal-page", "ok", null, FOTBAL_URL, `navigated`);

// 3. Search icon
const searchIconSel = "#sub-nav-search-icon";
const searchIconVisible = await page.locator(searchIconSel).isVisible({ timeout: 5_000 }).catch(() => false);
check("search-icon", searchIconVisible ? "ok" : "fail", searchIconSel, FOTBAL_URL, null);

// 4. Open search and type
if (searchIconVisible) {
  await page.locator(searchIconSel).click();
  await page.waitForTimeout(1_000);
  const searchInput = page.locator("input[type='search'], input[placeholder*='aut' i]").first();
  const searchVisible = await searchInput.isVisible({ timeout: 3_000 }).catch(() => false);
  check("search-input", searchVisible ? "ok" : "fail", "input[type='search']", FOTBAL_URL, null);

  if (searchVisible) {
    await searchInput.fill("Arsenal");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2_000);

    // 5. Search results
    const resultSel = "[class*='search-result'], [class*='SearchResult'], a[href*='/fotbal/']";
    const resultVisible = await page.locator(resultSel).first().isVisible({ timeout: 5_000 }).catch(() => false);
    check("search-results", resultVisible ? "ok" : "fail", resultSel, null, "searched 'Arsenal'");

    // 6. Click first result
    if (resultVisible) {
      await page.locator(resultSel).first().click();
      await page.waitForTimeout(3_000);
      const url = page.url();
      const onEventPage = url.includes("/fotbal/") && url !== FOTBAL_URL;
      check("event-page-nav", onEventPage ? "ok" : "fail", null, url, null);

      // 7. Odds buttons
      const oddsSel = "button.odds-button, .odds-button, button[class*='odds']";
      const oddsCount = await page.locator(oddsSel).count().catch(() => 0);
      check("odds-buttons", oddsCount > 0 ? "ok" : "fail", oddsSel, url, `${oddsCount} buttons found`);

      // 8. Betslip container
      const slipSel = "[class*='betslip'], [data-test*='betslip']";
      const slipVisible = await page.locator(slipSel).first().isVisible({ timeout: 3_000 }).catch(() => false);
      check("betslip-container", slipVisible ? "ok" : "fail", slipSel, url, null);
    }
  }
}

await browser.close();

// Write report
const report = {
  checkedAt: new Date().toISOString(),
  allOk: results.every(r => r.status === "ok"),
  results,
};
await fs.writeFile(HEALTH_FILE, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));
console.log(`\n${report.allOk ? "✅ All selectors OK" : "❌ Some selectors BROKEN"}`);
console.log(`Health file written: ${HEALTH_FILE}`);
