import { expect, test, type APIRequestContext } from "@playwright/test";

const expectedVersion = process.env.PAPERCLIPAI_VERSION!;
const companyName = `Canary Smoke ${Date.now()}`;
const agentName = "Canary Smoke Lead";

async function getJson<T>(request: APIRequestContext, url: string): Promise<T> {
  const response = await request.get(url);
  expect(response.ok()).toBe(true);
  return (await response.json()) as T;
}

test("the exact published canary installs and reaches Connect a model", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // Browser storage is scoped to the Paperclip origin, not to a data directory.
  // A customer can therefore start a freshly installed server with an existing
  // onboarding draft. Creating the organization invalidates the company list;
  // this release check must prove that a refetch does not remount the wizard
  // from that old draft and leave the customer on the name screen.
  await page.addInitScript(() => {
    localStorage.setItem("paperclip-onboarding-state", JSON.stringify({
      step: 1,
      companyName: "",
      createdCompanyId: null,
    }));
  });
  let delayCompanyListRefetch = false;
  await page.route("**/api/companies", async (route) => {
    if (delayCompanyListRefetch && route.request().method() === "GET") {
      // Make the invalidation window observable. The previous implementation
      // unmounted the live wizard for this entire request.
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await route.continue();
  });

  const health = await getJson<{
    status: string;
    version: string;
    serverVersion: string;
  }>(page.request, "/api/health");
  expect(health.status).toBe("ok");
  expect(health.version).toBe(expectedVersion);
  expect(health.serverVersion).toBe(expectedVersion);

  await page.goto("/onboarding");
  await expect(
    page.getByRole("heading", { name: "What is the name of your organization?" }),
  ).toBeVisible();
  await page.getByRole("textbox").fill(companyName);
  delayCompanyListRefetch = true;
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  const agentNameField = page.locator("#onboarding-agent-name");
  await expect(agentNameField).toBeVisible({ timeout: 30_000 });

  const companies = await getJson<Array<{ id: string; name: string }>>(
    page.request,
    "/api/companies",
  );
  const company = companies.find((candidate) => candidate.name === companyName);
  expect(company, `organization ${companyName} should exist through the API`).toBeTruthy();

  expect(
    await getJson<Array<{ id: string }>>(
      page.request,
      `/api/companies/${company!.id}/agents`,
    ),
  ).toEqual([]);
  expect(
    await getJson<Array<{ id: string }>>(
      page.request,
      `/api/companies/${company!.id}/issues`,
    ),
  ).toEqual([]);

  await agentNameField.fill(agentName);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();

  await expect.poll(
    () => getJson<Array<{ id: string }>>(
      page.request,
      `/api/companies/${company!.id}/agents`,
    ),
    { message: "Connect a model must retain one paused setup record" },
  ).toEqual([
    expect.objectContaining({
      name: agentName,
      status: "paused",
      pauseReason: "setup",
      metadata: expect.objectContaining({ setupAdapterPending: true }),
      runtimeConfig: expect.objectContaining({
        heartbeat: expect.objectContaining({ enabled: false }),
      }),
    }),
  ]);
  expect(
    await getJson<Array<{ id: string }>>(
      page.request,
      `/api/companies/${company!.id}/issues`,
    ),
  ).toEqual([]);
  expect(
    await getJson<Array<{ id: string }>>(
      page.request,
      `/api/companies/${company!.id}/heartbeat-runs`,
    ),
  ).toEqual([]);
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});
