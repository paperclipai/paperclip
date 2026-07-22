import pw from "/work/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js";

const { chromium } = pw;
const pluginId = "74f6a1d9-e24d-4131-b4c2-80b47a32430b";
const watchdogId = "f995f313-d73f-401a-836b-e779625649dc";
const path = `/CK/company/settings/instance/plugins/${pluginId}`;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const results = [];

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000, trigger: true },
  { name: "mobile", width: 390, height: 844, trigger: false },
]) {
  const page = await browser.newPage({ viewport });
  const consoleErrors = [];
  const failedResources = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failedResources.push({ status: response.status(), url: response.url() });
    }
  });

  const response = await page.goto(`http://127.0.0.1:3100${path}`, {
    waitUntil: "networkidle",
    timeout: 30_000,
  });
  if (viewport.name === "desktop") {
    await page.getByText("Status", { exact: true }).first().click();
  } else {
    await page.locator("select").nth(1).selectOption({ label: "Status" });
  }
  await page.getByText("Scheduled Jobs", { exact: true }).waitFor();
  const configured = (await page.getByText(/\d+ configured/).first().textContent())?.trim();
  const jobRows = page.locator('button[aria-label^="Run "][aria-label$=" now"]');
  const jobCount = await jobRows.count();
  const watchdogButton = page.getByRole("button", {
    name: "Run ck.stall-watchdog now",
  });
  await watchdogButton.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `/work/.ckshots/plugin-job-controls-${viewport.name}.png`,
    fullPage: true,
  });

  let manualRun = null;
  if (viewport.trigger) {
    await watchdogButton.click();
    await page.getByText("Run scheduled job now?", { exact: true }).waitFor();
    const warning = (await page.getByText(/may write data, contact connected systems/).textContent())?.trim();
    await page.screenshot({
      path: "/work/.ckshots/plugin-job-controls-confirmation.png",
      fullPage: false,
    });
    const triggerResponsePromise = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" &&
        candidate.url().endsWith(`/jobs/${watchdogId}/trigger`),
    );
    await page.getByRole("button", { name: "Run job" }).click();
    const triggerResponse = await triggerResponsePromise;
    const triggerBody = await triggerResponse.json();
    await page.waitForTimeout(500);
    const runs = await page.evaluate(
      async ({ pluginId, watchdogId }) => {
        const result = await fetch(
          `/api/plugins/${pluginId}/jobs/${watchdogId}/runs?limit=1`,
        );
        return result.json();
      },
      { pluginId, watchdogId },
    );
    manualRun = {
      warning,
      triggerStatus: triggerResponse.status(),
      runId: triggerBody.runId,
      recordedStatus: runs[0]?.status,
      recordedTrigger: runs[0]?.trigger,
      recordedError: runs[0]?.error,
    };
  }

  results.push({
    viewport: viewport.name,
    status: response?.status(),
    configured,
    jobCount,
    watchdogEnabled: await watchdogButton.isEnabled(),
    manualRun,
    consoleErrors,
    failedResources,
  });
  await page.close();
}

console.log(JSON.stringify(results, null, 2));
await browser.close();
