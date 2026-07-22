// Direct-navigation smoke test for every unprefixed board route.
import pw from "/work/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js";

const { chromium } = pw;
const roots = process.argv.slice(2);
if (roots.length === 0) throw new Error("Pass one or more route roots");

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const results = [];

for (const root of roots) {
  const consoleErrors = [];
  const failedResources = [];
  const onConsole = (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  };
  const onResponse = (response) => {
    if (response.status() >= 400) failedResources.push({ status: response.status(), url: response.url() });
  };
  page.on("console", onConsole);
  page.on("response", onResponse);
  const response = await page.goto(`http://127.0.0.1:3100/${root}`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  }).catch((error) => ({ error: String(error) }));
  await page.waitForTimeout(700);
  results.push({
    root,
    status: response?.error ?? response?.status?.() ?? null,
    finalPath: new URL(page.url()).pathname,
    title: await page.title(),
    mainTextLength: (await page.locator("main").innerText().catch(() => "")).trim().length,
    pluginUnavailable: await page.getByText("Plugin content unavailable", { exact: true }).count(),
    notFound: await page.getByText("Page not found", { exact: true }).count(),
    companyNotFound: await page.getByText("Company not found", { exact: true }).count(),
    consoleErrors: consoleErrors.slice(0, 3),
    failedResources: failedResources.slice(0, 3),
  });
  page.off("console", onConsole);
  page.off("response", onResponse);
}

console.log(JSON.stringify(results, null, 2));
await browser.close();
