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
  const failedResources = [];
  const issueResponses = [];
  const bodyReads = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failedResources.push({ status: response.status(), url: response.url() });
    }
    if (response.url().includes("/api/companies/") && response.url().includes("/issues?")) {
      bodyReads.push(
        response.body().then((body) => {
          issueResponses.push({
            url: response.url(),
            status: response.status(),
            bytes: body.byteLength,
          });
        }),
      );
    }
  });

  const response = await page.goto("http://127.0.0.1:3100/CK/inbox/mine", {
    waitUntil: "networkidle",
    timeout: 30_000,
  });
  const searchInput = page.locator('input[placeholder="Search inbox…"]:visible').first();
  await searchInput.waitFor();
  await Promise.all(bodyReads);
  const initialIssueResponses = [...issueResponses];
  const initialRows = await page.locator("[data-inbox-item]").count();
  const initialText = await page.locator("main").innerText().catch(() => page.locator("body").innerText());

  let historicalSearchFound = null;
  if (viewport.name === "desktop") {
    const searchResponsePromise = page.waitForResponse(
      (candidate) =>
        candidate.url().includes("/issues?") &&
        candidate.url().includes("q=Gourmet"),
    );
    await searchInput.fill("Gourmet");
    await searchResponsePromise;
    await page.waitForTimeout(300);
    historicalSearchFound = (await page.locator("body").innerText()).includes(
      "Gourmet & Cigar Club Lucerne",
    );
  }

  await page.screenshot({
    path: `/work/.ckshots/inbox-active-index-${viewport.name}.png`,
    fullPage: true,
  });
  results.push({
    viewport: viewport.name,
    status: response?.status(),
    initialRows,
    currentItemPresent: initialText.includes("ART CIGAR"),
    historicalSearchFound,
    initialIssueResponses,
    consoleErrors,
    failedResources,
  });
  await page.close();
}

console.log(JSON.stringify(results, null, 2));
await browser.close();
