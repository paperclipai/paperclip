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

  // Stop before Connect: a public-repository gate must not require a Claude or
  // Codex credential, and reaching this screen has not hired an agent or made
  // a first task.
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
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});
