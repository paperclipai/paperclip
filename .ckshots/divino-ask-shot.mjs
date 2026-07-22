import pw from "/work/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js";
const { chromium } = pw;
const url = "http://127.0.0.1:3100/CK/ck-divino";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const log = [];
const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
page.on("pageerror", (e) => log.push("pageerr:" + String(e).slice(0, 140)));
await page.goto(url, { waitUntil: "networkidle", timeout: 40000 }).catch((e) => log.push("goto:" + e));
await page.waitForTimeout(2500);
const ask = page.getByRole("button", { name: "Ask Divino", exact: true });
if (await ask.count().catch(() => 0)) { await ask.first().click().catch(() => {}); await page.waitForTimeout(1200); }
const box = page.getByPlaceholder("Message Divino…");
if (await box.count().catch(() => 0)) {
  await box.first().fill("In one short sentence: what's the single most urgent thing on the marketplace right now?");
  await box.first().press("Enter");
  log.push("sent");
}
// wait for the reply bubble (poll up to ~40s)
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1500);
  const t = (await page.locator("body").innerText().catch(() => "")) || "";
  if (!t.includes("Divino is thinking") && /urgent|Locanto|Ricardo|browser|listing|repost|stale/i.test(t.split("most urgent thing")[1] || "")) { log.push("reply@" + (i * 1.5) + "s"); break; }
}
await page.waitForTimeout(800);
await page.screenshot({ path: "/work/.ckshots/divino-ask-desktop.png", fullPage: false });
console.log(JSON.stringify({ url, log }, null, 0));
await browser.close();
