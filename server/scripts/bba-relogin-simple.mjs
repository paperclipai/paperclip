/**
 * Simple re-login: fresh browser (no profile clone), user logs in manually, cookies saved.
 * Usage: node scripts/bba-relogin-simple.mjs
 */
import { chromium } from "playwright";
import fs from "fs/promises";
import os from "os";
import path from "path";

const COOKIE_CACHE = path.join(os.homedir(), ".paperclip", "bba-cookie-cache.json");
const CASA_URL = "https://www.casapariurilor.ro";
const LOGIN_BTN = ".header-login-wrapper.user-box-link";

console.log("=== BBA Simple Re-login ===");
console.log("Cookie cache:", COOKIE_CACHE);
console.log("");
console.log("Instructiuni:");
console.log("  1. Se deschide browserul la casapariurilor.ro");
console.log("  2. Apasa CONECTARE si logheaza-te manual");
console.log("  3. Asteapta detectia automata si salvarea sesiunii");
console.log("");

const browser = await chromium.launch({ headless: false, slowMo: 0 });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  locale: "ro-RO",
  timezoneId: "Europe/Bucharest",
});
const page = await ctx.newPage();
await page.goto(CASA_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

console.log("Browser deschis. Asteapt login...");

const deadline = Date.now() + 5 * 60 * 1000; // 5 minute timeout
while (Date.now() < deadline) {
  await page.waitForTimeout(2_000);
  const loginBtnVisible = await page.locator(LOGIN_BTN).isVisible({ timeout: 1_000 }).catch(() => true);
  if (!loginBtnVisible) {
    console.log("✅ Login detectat! Salvez sesiunea...");
    const state = await ctx.storageState();
    await fs.writeFile(COOKIE_CACHE, JSON.stringify(state, null, 2), "utf8");
    console.log(`✅ ${state.cookies.length} cookies salvate in ${COOKIE_CACHE}`);
    console.log("Poti inchide browserul.");
    await page.waitForTimeout(3_000);
    await browser.close();
    process.exit(0);
  }
}

console.log("❌ Timeout 5 minute — login nedetectat.");
await browser.close();
process.exit(1);
