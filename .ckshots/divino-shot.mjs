import pw from "/work/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js";
const { chromium } = pw;
const base = "http://127.0.0.1:3100";
const url = base + "/CK/ck-divino";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const log = [];

async function shoot(page, name) {
  await page.screenshot({ path: `/work/.ckshots/${name}.png`, fullPage: false });
  log.push(name);
}
async function clickTab(page, label) {
  const b = page.getByRole("button", { name: label, exact: true });
  if (await b.count().catch(() => 0)) { await b.first().click().catch(() => {}); await page.waitForTimeout(1200); }
}

// Desktop
const page = await chromium.launch ? await browser.newPage({ viewport: { width: 1400, height: 1000 } }) : null;
page.on("pageerror", (e) => log.push("pageerr:" + String(e).slice(0, 120)));
await page.goto(url, { waitUntil: "networkidle", timeout: 40000 }).catch((e) => log.push("goto:" + e));
await page.waitForTimeout(3000);
const bodyText = (await page.locator("body").innerText().catch(() => "")) || "";
log.push("seen:" + ["Marketplace Cockpit", "Listings live", "Platform coverage", "Stealth browser", "Tutti", "Locanto"].filter((k) => bodyText.includes(k)).join(","));
await shoot(page, "divino-cockpit-desktop");
await clickTab(page, "Listings");
await shoot(page, "divino-listings-desktop");
await clickTab(page, "Platforms");
await shoot(page, "divino-platforms-desktop");

// Mobile
const m = await browser.newPage({ viewport: { width: 420, height: 900 } });
await m.goto(url, { waitUntil: "networkidle", timeout: 40000 }).catch((e) => log.push("mgoto:" + e));
await m.waitForTimeout(3000);
await shoot(m, "divino-cockpit-mobile");

console.log(JSON.stringify({ url, log }, null, 0));
await browser.close();
