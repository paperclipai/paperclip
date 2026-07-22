import pw from "/work/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js";

const { chromium } = pw;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
const failedResponses = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(String(error)));
page.on("response", (response) => {
  if (response.status() >= 400) {
    failedResponses.push({ status: response.status(), url: response.url() });
  }
});

await page.goto("http://127.0.0.1:3100/CK/dashboard", {
  waitUntil: "networkidle",
});
await page.getByText("New Task", { exact: true }).first().click();
const placeholder = page.getByText("Add description...", { exact: true });
const placeholderBox = await placeholder.boundingBox();
if (!placeholderBox) throw new Error("Description placeholder was not visible");
await page.mouse.click(
  placeholderBox.x + placeholderBox.width / 2,
  placeholderBox.y + placeholderBox.height / 2,
);
await page.keyboard.type("Normal-click focus verification. This task will not be created.");

const editorText = await page
  .locator('[contenteditable="true"]')
  .last()
  .textContent();
await page.screenshot({
  path: "/work/.ckshots/new-task-description-normal-click.png",
  fullPage: true,
});

console.log(
  JSON.stringify(
    {
      url: page.url(),
      editorText,
      normalClickWorked: editorText?.includes("Normal-click focus verification") ?? false,
      errors,
      failedResponses,
    },
    null,
    2,
  ),
);
await browser.close();
