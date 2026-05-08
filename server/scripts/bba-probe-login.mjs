/**
 * Probes the Casa Pariurilor login modal DOM to find exact selector names.
 * Usage: node scripts/bba-probe-login.mjs
 */
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "ro-RO" });
const page = await ctx.newPage();
await page.goto("https://www.casapariurilor.ro", { waitUntil: "domcontentloaded", timeout: 30_000 });
await page.waitForTimeout(3_000);

// Dismiss cookie banner if present
const cookie = page.locator("button:has-text('ACCEPT TOATE'), button:has-text('Accept toate')").first();
if (await cookie.isVisible({ timeout: 2_000 }).catch(() => false)) {
  await cookie.click();
  await page.waitForTimeout(1_000);
}

// Click CONECTARE to open modal
const loginBtn = page.locator(".header-login-wrapper.user-box-link, a:has-text('CONECTARE'), button:has-text('CONECTARE')").first();
const loginBtnVisible = await loginBtn.isVisible({ timeout: 5_000 }).catch(() => false);
if (loginBtnVisible) {
  console.log("Clicking CONECTARE...");
  await loginBtn.click();
  await page.waitForTimeout(2_000);
} else {
  console.log("CONECTARE not visible — session may already be active or page blocked");
}

// Probe all visible inputs
const inputs = await page.evaluate(() =>
  Array.from(document.querySelectorAll("input")).filter(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }).map(el => ({
    type: el.type,
    name: el.name,
    id: el.id,
    placeholder: el.placeholder,
    autocomplete: el.autocomplete,
    className: el.className.slice(0, 100),
    value: el.value ? "[filled]" : "[empty]",
  }))
);
console.log("\n=== VISIBLE INPUTS ===");
console.log(JSON.stringify(inputs, null, 2));

// Probe visible buttons
const buttons = await page.evaluate(() =>
  Array.from(document.querySelectorAll("button")).filter(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }).slice(0, 20).map(el => ({
    text: el.innerText.trim().slice(0, 50),
    type: el.type,
    className: el.className.slice(0, 100),
  }))
);
console.log("\n=== VISIBLE BUTTONS ===");
console.log(JSON.stringify(buttons, null, 2));

// Check for iframes
const frames = page.frames();
console.log(`\n=== FRAMES: ${frames.length} ===`);
frames.forEach((f, i) => console.log(`  [${i}] url=${f.url()}`));

await browser.close();
console.log("\nDone.");
