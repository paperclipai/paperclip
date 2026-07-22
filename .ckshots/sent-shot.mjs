import pw from "/work/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js";
const { chromium } = pw;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 1 });
await page.goto("http://127.0.0.1:8085/", { waitUntil: "networkidle", timeout: 30000 }).catch(()=>{});
await page.waitForTimeout(2500);
const hasLogin = await page.$("input[type=password]");
if (hasLogin) {
  await page.fill("input[name=username], #field-userName", "ck-admin").catch(()=>{});
  await page.fill("input[type=password]", process.env.CRMPW).catch(()=>{});
  await page.keyboard.press("Enter").catch(()=>{});
  await page.waitForTimeout(4000);
}
// go to Email list, Sent folder
await page.goto("http://127.0.0.1:8085/#Email/list/folder=sent", { waitUntil: "networkidle", timeout: 30000 }).catch(()=>{});
await page.waitForTimeout(4500);
await page.screenshot({ path: "/work/.ckshots/sent.png", fullPage: false });
console.log(JSON.stringify({ url: page.url(), title: await page.title().catch(()=>"" ) }));
await browser.close();
