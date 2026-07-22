import pw from "/work/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js";

const { chromium } = pw;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
const mutations = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(String(error)));
page.on("dialog", (dialog) => dialog.accept());
page.on("response", (response) => {
  if (response.request().method() !== "GET") {
    mutations.push({
      method: response.request().method(),
      status: response.status(),
      url: response.url(),
    });
  }
});

await page.goto("http://127.0.0.1:3100/CK/ck-approvals", {
  waitUntil: "networkidle",
  timeout: 30_000,
});
await page.getByRole("button", { name: "Cancel", exact: true }).click();
await page.waitForTimeout(1200);
await page.screenshot({
  path: "/tmp/sync-outbox-after-cancel.png",
  fullPage: true,
});
console.log(JSON.stringify({
  pendingFixture: await page.getByText("Internal sync fixture 2", { exact: true }).count(),
  mutations,
  errors,
}, null, 2));
await browser.close();
