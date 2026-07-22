import pw from "/work/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js";
const { chromium } = pw;
const url = "http://127.0.0.1:3100/CK/ck-divino";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const log = [];
const page = await browser.newPage({ viewport: { width: 1240, height: 1050 } });
page.on("pageerror", (e) => log.push("pageerr:" + String(e).slice(0, 140)));
await page.goto(url, { waitUntil: "networkidle", timeout: 40000 }).catch((e) => log.push("goto:" + e));
await page.waitForTimeout(2500);
async function tab(label, file, waitMs) {
  const b = page.getByRole("button", { name: label, exact: true });
  if (await b.count().catch(() => 0)) { await b.first().click().catch(() => {}); await page.waitForTimeout(waitMs); }
  await page.screenshot({ path: `/work/.ckshots/${file}.png`, fullPage: false });
}
await tab("Products", "divino-products-thumbs", 3500);
await tab("Platforms", "divino-platforms-profile", 1500);
await tab("Mail", "divino-mail", 9000); // IMAP fetch is slow
console.log(JSON.stringify({ url, log }, null, 0));
await browser.close();
