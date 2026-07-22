import pw from "/work/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js";
const { chromium } = pw;
const url = "http://127.0.0.1:3100/CK/ck-divino";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const log = [];
const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
page.on("pageerror", (e) => log.push("pageerr:" + String(e).slice(0, 140)));
await page.goto(url, { waitUntil: "networkidle", timeout: 40000 }).catch((e) => log.push("goto:" + e));
await page.waitForTimeout(2500);
const c = page.getByRole("button", { name: "Control", exact: true });
if (await c.count().catch(() => 0)) { await c.first().click().catch(() => {}); await page.waitForTimeout(2500); }
const body = (await page.locator("body").innerText().catch(() => "")) || "";
log.push("seen:" + ["Health-check all", "dry-run", "Refresh", "Post next", "Run log", "refresh", "posts"].filter((k) => body.includes(k)).join(","));
await page.screenshot({ path: "/work/.ckshots/divino-control-desktop.png", fullPage: false });
console.log(JSON.stringify({ url, log }, null, 0));
await browser.close();
