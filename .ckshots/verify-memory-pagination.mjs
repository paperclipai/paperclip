import pw from "/work/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js";

const { chromium } = pw;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const results = [];

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
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

  await page.goto("http://127.0.0.1:3100/CK/ck-memory", { waitUntil: "networkidle" });
  const initialRows = await page.locator("tbody tr").count();
  const initialSummary = await page.getByText(/Showing \d+–\d+ of \d+/).textContent();
  const initialTextLength = (await page.locator("main").innerText()).length;
  const expectedMaxRows = viewport.name === "mobile" ? 10 : 25;

  if (initialRows > expectedMaxRows) throw new Error(`${viewport.name}: rendered ${initialRows} memory rows`);

  let searchRows = null;
  let searchSummary = null;
  if (viewport.name === "desktop") {
    await page.getByLabel("Search memories").fill("ART CIGAR");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.waitForTimeout(500);
    searchRows = await page.locator("tbody tr").count();
    searchSummary = await page.getByText(/Showing \d+–\d+ of \d+/).textContent();
    if (searchRows > 25) throw new Error(`search rendered ${searchRows} memory rows`);
    if (!(await page.locator("main").innerText()).toLowerCase().includes("art cigar")) {
      throw new Error("search result did not contain the requested term");
    }
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await page.waitForTimeout(500);
  }

  await page.screenshot({
    path: `/work/.ckshots/memory-pagination-${viewport.name}.png`,
    fullPage: true,
  });

  results.push({
    viewport: viewport.name,
    initialRows,
    expectedMaxRows,
    initialSummary,
    initialTextLength,
    searchRows,
    searchSummary,
    consoleErrors,
    failedResponses,
  });
  await page.close();
}

console.log(JSON.stringify(results, null, 2));
await browser.close();
