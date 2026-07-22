// Headless screenshot helper for the Paperclip GUI (localhost only).
// Usage: node shoot.mjs <urlPath> <outFile> [waitMs] [width] [height]
import pw from "/work/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js";
const { chromium } = pw;
const [, , urlPath = "/", outFile = "shot.png", waitMs = "2500", width = "1440", height = "900"] = process.argv;
const base = "http://127.0.0.1:3100";
const url = urlPath.startsWith("http") ? urlPath : base + (urlPath.startsWith("/") ? urlPath : "/" + urlPath);
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({
  viewport: { width: Number(width), height: Number(height) },
  deviceScaleFactor: 1,
});
const errs = [];
const failedResources = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
page.on("pageerror", (e) => errs.push(String(e)));
page.on("response", (response) => {
  if (response.status() >= 400) {
    failedResources.push({ status: response.status(), url: response.url() });
  }
});
const resp = await page.goto(url, { waitUntil: "networkidle", timeout: 30000 }).catch((e) => ({ _err: String(e) }));
await page.waitForTimeout(1500);
// Optional: click a sidebar/nav item by its visible text (CLICK env), e.g. CLICK="CK Org".
if (process.env.CLICK) {
  await page.getByText(process.env.CLICK, { exact: true }).first().click({ timeout: 10000 }).catch((e) => errs.push("click: " + String(e)));
  await page.waitForLoadState("networkidle").catch(() => {});
}
const selectIndex = Number(process.env.SELECT_INDEX ?? 0);
const selectLocator = page.locator("select").nth(selectIndex);

// Optional: select a mobile tab dropdown option by visible label (SELECT env), e.g. SELECT="Status".
if (process.env.SELECT) {
  await selectLocator.selectOption({ label: process.env.SELECT }).catch((e) => errs.push("select: " + String(e)));
  await page.waitForLoadState("networkidle").catch(() => {});
}
// Optional: select a mobile tab dropdown option by value (SELECT_VALUE env), e.g. SELECT_VALUE="status".
if (process.env.SELECT_VALUE) {
  await selectLocator.selectOption({ value: process.env.SELECT_VALUE }).catch((e) => errs.push("select_value: " + String(e)));
  await page.waitForLoadState("networkidle").catch(() => {});
}
if (process.env.FILL) {
  const label = process.env.FILL_LABEL || "Find an agent";
  await page.getByLabel(label).fill(process.env.FILL);
  await page.waitForTimeout(300);
}
await page.waitForTimeout(Number(waitMs));
await page.screenshot({ path: outFile, fullPage: process.env.FULL_PAGE !== "0" });
const title = await page.title().catch(() => "");
console.log(JSON.stringify({
  url,
  finalUrl: page.url(),
  viewport: { width: Number(width), height: Number(height) },
  status: resp?._err ? resp._err : resp?.status?.(),
  title,
  consoleErrors: errs.slice(0, 8),
  failedResources: failedResources.slice(0, 8),
}, null, 2));
await browser.close();
