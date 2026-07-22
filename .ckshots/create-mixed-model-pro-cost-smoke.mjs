import pw from "/work/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js";

const { chromium } = pw;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));
page.on("response", (response) => {
  if (response.status() >= 400) failedResponses.push({ status: response.status(), url: response.url() });
});

await page.goto("http://127.0.0.1:3100/CK/dashboard", { waitUntil: "networkidle" });
await page.getByText("New Task", { exact: true }).first().click();
await page.getByPlaceholder("Task title").fill("Internal review: mixed-model cost attribution contract");
const placeholder = page.getByText("Add description...", { exact: true });
const box = await placeholder.boundingBox();
if (!box) throw new Error("Description placeholder was not visible");
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.keyboard.type(
  "Review only this supplied evidence: Paperclip now records one idempotent cost row per model inside a heartbeat, aggregate runtime totals remain unchanged, and mismatched breakdown totals fall back to one aggregate row. Return a concise PASS or NEEDS WORK verdict with one reason. Do not call tools, delegate, create tasks, contact anyone, or perform external actions. End with Next action (owner): none.",
);
await page.getByRole("button", { name: "Assignee", exact: true }).click();
await page.getByRole("button", { name: "GOV-11 Department-Evaluator", exact: true }).last().click();
await page.getByRole("button", { name: "Project", exact: true }).click();
await page.keyboard.type("CK Operations");
await page.keyboard.press("Enter");
await page.getByRole("button", { name: "Create Task", exact: true }).click();
const createdToast = page.getByText(/^Created CK-\d+$/).first();
await createdToast.waitFor({ timeout: 15_000 });
const createdText = (await createdToast.textContent()) || "";
const identifier = createdText.match(/CK-\d+/)?.[0];
if (!identifier) throw new Error(`Could not parse created task from '${createdText}'`);
await page.getByRole("link", { name: `Open ${identifier}`, exact: true }).click();
await page.waitForURL(new RegExp(`/issues/${identifier}$`), { timeout: 15_000 });
await page.waitForLoadState("networkidle").catch(() => {});
await page.screenshot({ path: "/work/.ckshots/mixed-model-pro-cost-smoke-created.png", fullPage: true });
console.log(JSON.stringify({ identifier, url: page.url(), consoleErrors, failedResponses }, null, 2));
await browser.close();
