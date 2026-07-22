import pw from "/work/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js";

const { chromium } = pw;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(String(error)));

await page.goto("http://127.0.0.1:3100/CK/dashboard", {
  waitUntil: "networkidle",
  timeout: 30_000,
});
await page.getByText("New Task", { exact: true }).first().click();
await page.getByPlaceholder("Task title").fill(
  "Approval sync verification — no email",
);
await page.getByText("Add description...", { exact: true }).click({ force: true });
await page.keyboard.type(
  "Internal UI regression fixture. Reject the pending card to prove the task and Outreach outbox stay synchronized. No email may be sent.",
);
await page.getByRole("button", { name: "Project", exact: true }).click();
await page.keyboard.type("CK Operations");
await page.keyboard.press("Enter");
await page.getByRole("button", { name: "Create Task", exact: true }).click();
await page.waitForTimeout(1500);
await page.screenshot({
  path: "/tmp/approval-sync-test-created.png",
  fullPage: true,
});

console.log(JSON.stringify({
  url: page.url(),
  title: await page.title(),
  errors,
}, null, 2));
await browser.close();
