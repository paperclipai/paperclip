import pw from "/work/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js";

const { chromium } = pw;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(String(error)));

await page.goto("http://127.0.0.1:3100/CK/ck-approvals", {
  waitUntil: "networkidle",
  timeout: 30_000,
});

const card = page.locator("text=Gstaad Palace").first().locator("..");
const cancel = page.getByRole("button", { name: "Cancel", exact: true });
if ((await cancel.count()) !== 1) {
  throw new Error(`Expected one Cancel button, found ${await cancel.count()}`);
}

const responses = [];
page.on("response", (response) => {
  if (response.request().method() !== "GET") {
    responses.push({
      method: response.request().method(),
      status: response.status(),
      url: response.url(),
    });
  }
});

await cancel.click();
await page.waitForTimeout(1500);

await page.screenshot({
  path: "/tmp/gstaad-outbox-after-cancel.png",
  fullPage: true,
});

console.log(JSON.stringify({
  finalUrl: page.url(),
  gstaadVisible: await page.getByText("Gstaad Palace", { exact: true }).count(),
  pendingVisible: await page.getByText("PENDING", { exact: true }).count(),
  responses,
  errors,
}, null, 2));

await browser.close();
