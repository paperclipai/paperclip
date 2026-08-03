import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { listenOnFetchAllowedPort } from "./fetch-allowed-port";

// Apps navigation — dark-mode + navigation QA for the prosumer Apps surfaces.
// Seeds a healthy app and a broken (needs-attention) app, forces dark theme,
// and screenshots /apps, the folded attention banner, and the Advanced/developer doors to
// prove the amber/emerald surfaces read correctly on dark.

const SCREENSHOT_DIR = "test-results";

type Seed = { companyId: string; prefix: string };

async function newCompany(request: APIRequestContext, label: string): Promise<Seed> {
  const res = await request.post("/api/companies", { data: { name: `Apps navigation ${label} ${Date.now()}` } });
  expect(res.ok(), `create company failed ${res.status()}: ${await res.text()}`).toBe(true);
  const company = await res.json();
  const flags = await request.patch("/api/instance/settings/experimental", { data: { enableApps: true } });
  expect(flags.ok(), `enable apps failed ${flags.status()}: ${await flags.text()}`).toBe(true);
  return {
    companyId: company.id,
    prefix: company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E",
  };
}

type MockMcpServer = { url: string; close: () => Promise<void> };

async function startMockMcp(): Promise<MockMcpServer> {
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let payload: { id?: string | number; method?: string } = {};
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      // fall through
    }
    if (payload.method === "tools/list") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id ?? null,
          result: {
            tools: [
              {
                name: "list_widgets",
                title: "List widgets",
                description: "Read-only listing of widgets.",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
              },
            ],
          },
        }),
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id ?? null, result: {} }));
  });
  const port = await listenOnFetchAllowedPort(server);
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function connectApp(request: APIRequestContext, seed: Seed, url: string): Promise<string> {
  const connect = await request.post(`/api/companies/${seed.companyId}/tools/apps/connect`, {
    data: { link: url, credentialValues: { "credentials.authorization": "qa-token" } },
  });
  expect(connect.ok(), `connect failed ${connect.status()}: ${await connect.text()}`).toBe(true);
  const body = await connect.json();
  const enabledCatalogEntryIds = (body.actions?.readOnly ?? []).map(
    (action: { catalogEntryId: string }) => action.catalogEntryId,
  );
  const finish = await request.post(`/api/companies/${seed.companyId}/tools/apps/${body.connectionId}/finish`, {
    data: { enabledCatalogEntryIds, askFirstCatalogEntryIds: [], access: "all_agents" },
  });
  expect(finish.ok(), `finish failed ${finish.status()}: ${await finish.text()}`).toBe(true);
  return body.connectionId as string;
}

async function forceDark(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("paperclip.theme", "dark"));
}

test.describe.serial("dark-mode Apps surfaces", () => {
  test.setTimeout(240_000);

  let healthy: MockMcpServer;
  let seed: Seed;
  let brokenId: string;

  test.beforeAll(async ({ request }) => {
    healthy = await startMockMcp();
    seed = await newCompany(request, "dark");

    // Healthy app.
    await connectApp(request, seed, healthy.url);

    // Broken app → needs attention. Use a `localhost` URL so the derived
    // connection name differs from the healthy `127.0.0.1` app.
    const ephemeral = await startMockMcp();
    brokenId = await connectApp(request, seed, ephemeral.url.replace("127.0.0.1", "localhost"));
    const brokenUrl = "http://localhost:65535/";
    const patch = await request.patch(`/api/tool-connections/${brokenId}`, {
      data: { config: { url: brokenUrl } },
    });
    expect(patch.ok(), `patch broken url failed ${patch.status()}: ${await patch.text()}`).toBe(true);
    await ephemeral.close();
    const health = await request.post(`/api/tool-connections/${brokenId}/health-check`);
    expect(health.status()).toBe(502);
  });

  test.afterAll(async () => {
    await healthy?.close();
  });

  test("sidebar says Apps and links to /apps", async ({ page }) => {
    await forceDark(page);
    await page.goto(`/${seed.prefix}/dashboard`);
    const appsLink = page.getByRole("link", { name: "Apps", exact: true });
    await expect(appsLink).toBeVisible({ timeout: 30_000 });
    await expect(appsLink).toHaveAttribute("href", new RegExp(`/${seed.prefix}/apps$`));
  });

  test("apps list dark mode with attention banner", async ({ page }) => {
    await forceDark(page);
    await page.goto(`/${seed.prefix}/apps`);
    await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/needs attention/i).first()).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/apps-nav-01-apps-dark.png`, fullPage: true });
  });

  test("attention banner dark mode", async ({ page }) => {
    await forceDark(page);
    await page.goto(`/${seed.prefix}/apps`);
    await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/app needs attention/i).first()).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/apps-nav-02-attention-dark.png`, fullPage: true });
  });

  test("advanced door defaults to Run your own with the merged Apps sidebar", async ({ page }) => {
    await forceDark(page);
    await page.goto(`/${seed.prefix}/apps/advanced`);
    await expect(page.getByRole("heading", { name: "Advanced setup" })).toBeVisible({ timeout: 30_000 });
    // Run your own is now the default tab (Apps navigation); merged sidebar shows Apps items too.
    await expect(page.getByText(/isolated workspace/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("link", { name: "Connections" })).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/apps-nav-03-advanced-run-dark.png`, fullPage: true });

    // Sidebar and tab switcher both link Paste a config — either lands on /paste-config.
    await page.getByRole("link", { name: "Paste a config" }).first().click();
    await expect(page).toHaveURL(/\/apps\/advanced\/paste-config$/);
    await expect(page.getByText(/Paste the MCP config snippet/i).first()).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/apps-nav-04-advanced-paste-dark.png`, fullPage: true });
  });

  test("developer tabs share the merged Apps sidebar", async ({ page }) => {
    await forceDark(page);
    await page.goto(`/${seed.prefix}/apps/advanced/profiles`);
    await expect(page.getByRole("heading", { name: "Developer tools" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Access profiles" })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('a[href$="/apps/advanced/runtime"]', { hasText: "Health" })).toBeVisible();
    await expect(page.locator('a[href$="/apps/advanced/audit"]', { hasText: "Activity" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Applications", exact: true })).toHaveCount(0);
    // Apps section lives in the same sidebar now.
    await expect(page.locator('a[href$="/apps"]', { hasText: "Connections" })).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/apps-nav-05-developer-overview-dark.png`, fullPage: true });
  });

  test("app detail rename and danger zone removal", async ({ page }) => {
    await forceDark(page);
    await page.goto(`/${seed.prefix}/apps/${brokenId}/advanced`);
    await expect(page.getByText("Danger zone")).toBeVisible({ timeout: 30_000 });

    // Rename from the header pencil.
    await page.getByRole("button", { name: "Rename app" }).click();
    await page.getByLabel("App name").fill("QA Renamed App");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("heading", { name: "QA Renamed App" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Remove app", exact: true }).click();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/apps-nav-06-danger-zone-dark.png`, fullPage: true });
    await page.getByRole("button", { name: "Yes, remove it" }).click();
    await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/apps$`), { timeout: 20_000 });
    await expect(page.getByText("App removed").first()).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/apps-nav-07-after-remove-dark.png`, fullPage: true });
  });
});
