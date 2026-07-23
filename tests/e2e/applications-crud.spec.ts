import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Current Apps lifecycle coverage. The legacy Tools -> Applications CRUD table
// was retired; old links now redirect to /apps. Keep this harness focused on
// the user-visible Connections list plus app detail setup/advanced flows.

type SeedResult = {
  companyId: string;
  prefix: string;
};

const SCREENSHOT_DIR = "test-results";
const APP_PREFIX = `QA 10820 ${Date.now().toString(36)}`;

async function discoverCompany(request: APIRequestContext): Promise<SeedResult> {
  const res = await request.post("/api/companies", {
    data: { name: `applications lifecycle ${Date.now()}` },
  });
  expect(res.ok(), `create company failed ${res.status()}: ${await res.text()}`).toBe(true);
  const company = await res.json();
  const flags = await request.patch("/api/instance/settings/experimental", { data: { enableApps: true } });
  expect(flags.ok(), `enable apps failed ${flags.status()}: ${await flags.text()}`).toBe(true);
  return {
    companyId: company.id,
    prefix: company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E",
  };
}

async function createApplication(
  request: APIRequestContext,
  companyId: string,
  body: { name: string; description?: string; type?: string },
): Promise<{ id: string; name: string }> {
  const res = await request.post(`/api/companies/${companyId}/tools/applications`, {
    data: { type: "mcp_http", ...body },
  });
  if (!res.ok()) throw new Error(`create app failed ${res.status()}: ${await res.text()}`);
  return res.json();
}

async function createConnection(
  request: APIRequestContext,
  companyId: string,
  data: { applicationName?: string; applicationId?: string; name: string; transport?: string; config?: object },
): Promise<{ id: string; applicationId: string; name: string }> {
  const res = await request.post(`/api/companies/${companyId}/tools/connections`, {
    data: {
      transport: "mcp_remote",
      config: { url: "https://fixture.example/mcp" },
      enabled: true,
      status: "active",
      ...data,
    },
  });
  if (!res.ok()) throw new Error(`create connection failed ${res.status()}: ${await res.text()}`);
  return res.json();
}

async function gotoApps(page: Page, prefix: string) {
  await page.goto(`/${prefix}/apps`);
  await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible({ timeout: 30_000 });
}

test.describe.serial("applications lifecycle", () => {
  let seed: SeedResult;

  test.beforeAll(async ({ request }) => {
    seed = await discoverCompany(request);
  });

  test.afterAll(async ({ request }) => {
    if (!seed?.companyId) return;
    await request.delete(`/api/companies/${seed.companyId}`).catch(() => undefined);
  });

  test("Connections list surfaces connected and not-connected apps", async ({ page, request }) => {
    const connectedName = `${APP_PREFIX}-connected`;
    const notConnectedName = `${APP_PREFIX}-not-connected`;
    const connected = await createConnection(request, seed.companyId, {
      applicationName: connectedName,
      name: connectedName,
    });
    const notConnected = await createApplication(request, seed.companyId, { name: notConnectedName });

    await gotoApps(page, seed.prefix);

    const connectedRow = page.locator("tbody tr", { hasText: connectedName });
    await expect(connectedRow).toBeVisible();
    await expect(connectedRow.getByText("Healthy")).toBeVisible();
    await expect(connectedRow.getByRole("button", { name: "Open" })).toBeVisible();

    const notConnectedRow = page.locator("tbody tr", { hasText: notConnectedName });
    await expect(notConnectedRow).toBeVisible();
    await expect(notConnectedRow.getByText("Not connected")).toBeVisible();
    await expect(notConnectedRow.getByRole("button", { name: "Connect" })).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/applications-crud-current-list.png`, fullPage: true });

    await connectedRow.getByRole("button", { name: "Open" }).click();
    await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/apps/${connected.id}`), { timeout: 20_000 });

    await gotoApps(page, seed.prefix);
    await notConnectedRow.getByRole("button", { name: "Connect" }).click();
    await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/apps/app/${notConnected.id}`), { timeout: 20_000 });
  });

  test("connected app detail supports pause, rename, and removal", async ({ page, request }) => {
    const appName = `${APP_PREFIX}-detail-app`;
    const renamed = `${APP_PREFIX}-renamed-app`;
    const connection = await createConnection(request, seed.companyId, {
      applicationName: appName,
      name: appName,
    });

    await page.goto(`/${seed.prefix}/apps/${connection.id}/setup`);
    await expect(page.getByRole("heading", { name: appName })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Agents can use this app" })).toBeVisible();

    await page.getByRole("switch", { name: "Pause this app" }).click();
    await expect(page.getByRole("heading", { name: "This app is paused" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("switch", { name: "Resume this app" }).click();
    await expect(page.getByRole("heading", { name: "Agents can use this app" })).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "Rename app" }).click();
    await page.getByLabel("App name").fill(renamed);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("heading", { name: renamed })).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/applications-crud-current-detail.png`, fullPage: true });

    await page.goto(`/${seed.prefix}/apps/${connection.id}/advanced`);
    await expect(page.getByText("Danger zone")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Remove app", exact: true }).click();
    await expect(page.getByRole("button", { name: "Yes, remove it" })).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/applications-crud-current-remove-connected.png`, fullPage: true });
    await page.getByRole("button", { name: "Yes, remove it" }).click();
    await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/apps$`), { timeout: 20_000 });
    await expect(page.getByText("App removed").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("tbody tr", { hasText: renamed })).toHaveCount(0);
  });

  test("not-connected app advanced page removes the application", async ({ page, request }) => {
    const cleanAppName = `${APP_PREFIX}-clean-remove-app`;
    const cleanApp = await createApplication(request, seed.companyId, { name: cleanAppName });

    await page.goto(`/${seed.prefix}/apps/app/${cleanApp.id}/advanced`);
    await expect(page.getByRole("heading", { name: cleanAppName })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Danger zone")).toBeVisible();
    await page.getByRole("button", { name: "Remove app", exact: true }).click();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/applications-crud-current-remove-not-connected.png`, fullPage: true });
    await page.getByRole("button", { name: "Yes, remove it" }).click();
    await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/apps$`), { timeout: 20_000 });
    await expect(page.getByText("App removed").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("tbody tr", { hasText: cleanAppName })).toHaveCount(0);
  });
});
