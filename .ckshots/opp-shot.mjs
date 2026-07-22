import pw from "/work/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js";
const { chromium } = pw;
const PWD = process.env.CRMPW;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
await page.goto("http://127.0.0.1:8085/", { waitUntil: "networkidle", timeout: 30000 }).catch((e)=>errs.push(String(e)));
await page.waitForTimeout(2500);
const hasLogin = await page.$("input[name=username], #field-userName, input[type=password]");
if (hasLogin) {
  await page.fill("input[name=username], #field-userName", "ck-admin").catch(()=>errs.push("user fill"));
  await page.fill("input[name=password], #field-password, input[type=password]", PWD).catch(()=>errs.push("pass fill"));
  await page.keyboard.press("Enter").catch(()=>{});
  await page.waitForTimeout(4000);
}
await page.goto("http://127.0.0.1:8085/#Opportunity/list", { waitUntil: "networkidle", timeout: 30000 }).catch((e)=>errs.push(String(e)));
await page.waitForTimeout(4500);
await page.screenshot({ path: "/work/.ckshots/crm-opportunities.png", fullPage: false });
console.log(JSON.stringify({ title: await page.title().catch(()=>""), url: page.url(), errs: errs.slice(0,5) }));
await browser.close();
