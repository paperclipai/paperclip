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

  await page.goto("http://127.0.0.1:3100/CK/company/settings/instance/plugins", {
    waitUntil: "networkidle",
  });

  const headings = await page.locator("main h2").allTextContents();
  const sectionLinksAndButtons = await page.locator("main section a, main section button").evaluateAll((nodes) =>
    nodes.map((node) => ({
      tag: node.tagName.toLowerCase(),
      text: (node.textContent || "").trim(),
      label: node.getAttribute("aria-label"),
      title: node.getAttribute("title"),
      href: node.getAttribute("href"),
    })),
  );

  await page.screenshot({
    path: `/work/.ckshots/plugin-keyboard-order-${viewport.name}.png`,
    fullPage: true,
  });

  results.push({
    viewport: viewport.name,
    headings,
    sectionLinksAndButtons,
    consoleErrors,
    failedResponses,
  });
  await page.close();
}

console.log(JSON.stringify(results, null, 2));
await browser.close();
