import pw from "/work/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js";

const { chromium } = pw;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
const mutations = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(String(error)));
page.on("response", (response) => {
  if (response.request().method() !== "GET") {
    mutations.push({
      method: response.request().method(),
      status: response.status(),
      url: response.url(),
    });
  }
});

await page.goto("http://127.0.0.1:3100/CK/issues/CK-413", {
  waitUntil: "networkidle",
  timeout: 30_000,
});
const reply = page.getByRole("textbox", { name: "editable markdown" });
await reply.fill("Workflow verification only: keep the corrected wording and return one approval.");
await page.getByRole("button", { name: "Send", exact: true }).click();
await page.waitForTimeout(1500);
await page.screenshot({
  path: "/work/.ckshots/ck413-comment-feedback-mobile.png",
  fullPage: true,
});

console.log(JSON.stringify({
  pendingCardCount: await page.getByRole("button", { name: "Approve & send", exact: true }).count(),
  mutations,
  errors,
}, null, 2));
await browser.close();
