import pw from "/work/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js";

const { chromium } = pw;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const results = [];

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]) {
  const page = await browser.newPage({ viewport });
  const consoleErrors = [];
  const failedResponses = [];

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push({ status: response.status(), url: response.url() });
  });

  await page.goto(
    "http://127.0.0.1:3100/CK/company/settings/instance/plugins/74f6a1d9-e24d-4131-b4c2-80b47a32430b",
    { waitUntil: "networkidle" },
  );

  const fields = await page.locator("input").evaluateAll((inputs) =>
    inputs.map((input) => {
      const id = input.id;
      const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim() : null;
      return {
        id,
        label,
        type: input.type,
        autocomplete: input.autocomplete,
        hasValue: input.value.length > 0,
        valueLength: input.value.length,
      };
    }),
  );
  const secretPickers = await page.getByText("Select an existing secret", { exact: true }).count();

  await page.screenshot({
    path: `/work/.ckshots/plugin-config-secrecy-${viewport.name}.png`,
    fullPage: true,
  });

  results.push({
    viewport: viewport.name,
    fields,
    secretPickers,
    consoleErrors,
    failedResponses,
  });
  await page.close();
}

console.log(JSON.stringify(results, null, 2));
await browser.close();
