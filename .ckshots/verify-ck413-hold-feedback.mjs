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
await page.getByRole("button", { name: "Hold", exact: true }).click();
await page.waitForTimeout(300);
const reason = page.getByPlaceholder("Optional: tell the agent what you'd change.");
await reason.fill("Use no dash or spaced hyphen in the subject. Write complete natural sentences with no sentence fragments. Keep the Swiss company and Dominican factory wording, neutral greeting, and German strength terms. Return one approval.");
const holdButtons = page.getByRole("button", { name: /hold|confirm|decline/i });
await holdButtons.last().click();
await page.waitForTimeout(1500);
await page.screenshot({
  path: "/work/.ckshots/ck413-hold-feedback-mobile.png",
  fullPage: true,
});

console.log(JSON.stringify({
  pendingCardCount: await page.getByRole("button", { name: "Approve & send", exact: true }).count(),
  mutations,
  errors,
}, null, 2));
await browser.close();
