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
});
await page.getByText("New Task", { exact: true }).first().click();
await page.getByPlaceholder("Task title").fill(
  "Select and prepare the next highest-value uncontacted prospect",
);
await page.getByText("Add description...", { exact: true }).click({ force: true });
await page.keyboard.type(
  "Act as Chief of Staff. From the live Espo CRM, select the single highest-value eligible prospect that has not yet been contacted and is not already represented by an active draft or approval. Explain the selection briefly. Delegate any missing verification to REV-04 and the German first-contact draft to REV-06. The final draft must use the normal deterministic review gate and create one editable Outreach outbox approval bound to the canonical draft task. Never send the email. Do not create wrapper tasks when a canonical task already exists.",
);
await page.getByRole("button", { name: "Assignee", exact: true }).click();
await page.waitForTimeout(300);
await page
  .getByRole("button", { name: "GOV-25 Chief-of-Staff", exact: true })
  .last()
  .click();
await page.getByRole("button", { name: "Project", exact: true }).click();
await page.keyboard.type("CK Operations");
await page.keyboard.press("Enter");
await page.screenshot({
  path: "/tmp/power-gov25-task-ready.png",
  fullPage: true,
});

await page.getByRole("button", { name: "Create Task", exact: true }).click();
await page.waitForURL(/\/issues\/CK-\d+/, { timeout: 15000 });
await page.waitForLoadState("networkidle").catch(() => {});
await page.screenshot({
  path: "/tmp/power-gov25-task-created.png",
  fullPage: true,
});
console.log(JSON.stringify({ url: page.url(), title: await page.title(), errors }, null, 2));
await browser.close();
