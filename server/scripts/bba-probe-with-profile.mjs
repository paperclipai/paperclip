/**
 * Same as bba-probe-login.mjs but uses the persistent profile, like BBA does.
 */
import { chromium } from "playwright";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { execSync } from "child_process";

const PROFILE_DIR = "C:\\Users\\thepr\\.paperclip\\bba-playwright-profile";
const COOKIE_CACHE = path.join(os.homedir(), ".paperclip", "bba-cookie-cache.json");

// Clone profile to temp
const cloneDir = path.join(os.tmpdir(), "bba-probe-clone-" + Date.now());
execSync(`xcopy /E /I /Q "${PROFILE_DIR}" "${cloneDir}"`, { stdio: "inherit" });
console.log("Profile cloned to:", cloneDir);

// Clear lock files
for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort"]) {
  try { fs.unlink(path.join(cloneDir, name)); } catch {}
}

const ctx = await chromium.launchPersistentContext(cloneDir, {
  headless: false,
  viewport: { width: 1280, height: 800 },
  locale: "ro-RO",
});
const page = ctx.pages()[0] ?? await ctx.newPage();

// Inject cookies
try {
  const cached = JSON.parse(await fs.readFile(COOKIE_CACHE, "utf8"));
  if (cached?.cookies?.length > 0) {
    await ctx.addCookies(cached.cookies);
    console.log(`Injected ${cached.cookies.length} cached cookies`);
  }
} catch { console.log("No cookie cache"); }

await page.goto("https://www.casapariurilor.ro", { waitUntil: "domcontentloaded", timeout: 45_000 });
await page.waitForTimeout(4_000);

// Probe visible inputs
const inputs = await page.evaluate(() =>
  Array.from(document.querySelectorAll("input")).filter(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }).map(el => ({ type: el.type, name: el.name, id: el.id, placeholder: el.placeholder, className: el.className.slice(0,80) }))
);
console.log("\n=== INPUTS (with profile) ===\n", JSON.stringify(inputs, null, 2));

// Check LOGIN_BTN visible
const loginBtn = await page.locator(".header-login-wrapper.user-box-link").isVisible({ timeout: 2000 }).catch(() => false);
console.log("\nCONECTARE visible:", loginBtn);
const userBalance = await page.locator(".user-balance, [class*='user-balance'], [class*='logged-in']").isVisible({ timeout: 2000 }).catch(() => false);
console.log("User balance/logged-in visible:", userBalance);

// Count frames
const frames = page.frames();
console.log(`\nFrames: ${frames.length}`);
frames.forEach((f, i) => console.log(`  [${i}] ${f.url().slice(0, 80)}`));

await page.screenshot({ path: "C:\\Users\\thepr\\.paperclip\\bba-probe-profile.png", fullPage: false });
console.log("\nScreenshot saved to ~/.paperclip/bba-probe-profile.png");

await ctx.close();
// Cleanup clone
try { execSync(`rmdir /S /Q "${cloneDir}"`, { stdio: "ignore" }); } catch {}
