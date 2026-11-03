import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function json(response: Awaited<ReturnType<APIRequestContext["get"]>>) {
  expect(response.ok(), `${response.status()}: ${await response.text()}`).toBe(true);
  return response.json();
}

async function failFirstLazyCss(page: Page) {
  const counts = { failed: 0, served: 0, documents: 0 };
  await page.route(/\/assets\/CompanyEnvironments-[^/]+\.css$/, async (route) => {
    if (counts.failed === 0) {
      counts.failed += 1;
      await route.abort("failed");
      return;
    }
    counts.served += 1;
    await route.continue();
  });
  page.on("request", (request) => {
    if (request.resourceType() === "document" && request.frame() === page.mainFrame()) counts.documents += 1;
  });
  return counts;
}

test.use({ serviceWorkers: "block" });

// Task-page styles now live in the initial CSS bundle. Exercise an emitted
// lazy stylesheet so this remains a real network/preload recovery test.
const environmentsPath = "/company/settings/instance/environments";

test("a failed lazy CSS preload recovers with one reload", async ({ page, request }) => {
  const company = await json(await request.post("/api/companies", {
    data: { name: `Chunk recovery ${randomUUID()}` },
  }));
  const counts = await failFirstLazyCss(page);

  await page.goto(`/${company.issuePrefix}${environmentsPath}`);
  await expect(page.getByText("Enable Environments in instance experimental settings to manage shared execution targets.")
    .or(page.getByTestId("instance-settings-environments-section"))).toBeVisible();

  await expect(page.getByText("This page hit an error")).toHaveCount(0);
  expect(counts.failed).toBe(1);
  expect(counts.served).toBeGreaterThan(0);
  expect(counts.documents).toBe(2);
});

test("a lazy CSS asset that stays broken reloads once, then shows the error", async ({ page, request }) => {
  const company = await json(await request.post("/api/companies", {
    data: { name: `Chunk recovery ${randomUUID()}` },
  }));
  let failed = 0;
  let documents = 0;
  await page.route(/\/assets\/CompanyEnvironments-[^/]+\.css$/, async (route) => {
    failed += 1;
    await route.abort("failed");
  });
  page.on("request", (request) => {
    if (request.resourceType() === "document" && request.frame() === page.mainFrame()) documents += 1;
  });

  await page.goto(`/${company.issuePrefix}${environmentsPath}`);

  await expect(page.getByText("This page hit an error")).toBeVisible();
  await expect(page.getByText(/Unable to preload CSS for .*CompanyEnvironments-/)).toBeVisible();
  await page.waitForTimeout(1_000);
  expect(documents).toBe(2);
  expect(failed).toBe(2);
});
