/**
 * Quick session check — opens headed Chromium with cached cookies, navigates to Casa.
 * Usage: node scripts/bba-check-session.mjs
 */
import { chromium } from "playwright";
import fs from "fs/promises";
import os from "os";
import path from "path";

const COOKIE_CACHE = path.join(os.homedir(), ".paperclip", "bba-cookie-cache.json");
const CASA_URL = "https://www.casapariurilor.ro";

const cached = JSON.parse(await fs.readFile(COOKIE_CACHE, "utf8"));
console.log(`Cookie cache: ${cached.cookies.length} cookies`);

const browser = await chromium.launch({ headless: false, slowMo: 0 });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "ro-RO" });
await ctx.addCookies(cached.cookies);
const page = await ctx.newPage();
await page.goto(CASA_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

const loginBtnVisible = await page.locator(".header-login-wrapper.user-box-link").isVisible({ timeout: 5000 }).catch(() => false);
if (loginBtnVisible) {
  console.log("❌ NU ești logat — butonul CONECTARE e vizibil");
} else {
  console.log("✅ Ești logat — butonul CONECTARE nu e vizibil");
}

console.log("Browserul rămâne deschis. Închide-l manual când ai terminat.");
await page.waitForEvent("close", { timeout: 300_000 }).catch(() => {});
await browser.close();
