import { expect, test, type APIRequestContext } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { listenOnFetchAllowedPort } from "./fetch-allowed-port";

// Apps navigation wave 6 — not-connected apps get a real app page.
// A row with no live connection must open /apps/app/:applicationId/setup (previous
// setup + advanced danger zone + reconnect prefill), not the generic connect wizard,
// and reconnecting must revive the same application/connection, not duplicate.

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

test.describe.serial("not-connected app page", () => {
  test.setTimeout(240_000);

  let mock: MockMcpServer;
  let seed: Seed;
  let applicationId: string;
  let connectionId: string;

  test.beforeAll(async ({ request }) => {
    mock = await startMockMcp();
    seed = await newCompany(request, "app-page");

    const connect = await request.post(`/api/companies/${seed.companyId}/tools/apps/connect`, {
      data: { link: mock.url, name: "Bla", credentialValues: { "credentials.authorization": "qa-token" } },
    });
    expect(connect.ok(), `connect failed ${connect.status()}: ${await connect.text()}`).toBe(true);
    const body = await connect.json();
    connectionId = body.connectionId as string;
    applicationId = body.application.id as string;

    // Archive the connection (Remove app), then resurrect the application so
    // it shows on /apps as "Not connected" — the state in Dotta's screenshot.
    const archive = await request.delete(`/api/tool-connections/${connectionId}`);
    expect(archive.ok(), `archive failed ${archive.status()}: ${await archive.text()}`).toBe(true);
    const revive = await request.patch(`/api/tool-applications/${applicationId}`, {
      data: { status: "active" },
    });
    expect(revive.ok(), `revive failed ${revive.status()}: ${await revive.text()}`).toBe(true);
  });

  test.afterAll(async () => {
    await mock?.close();
  });

  test("not-connected row opens the app page, not the generic wizard", async ({ page }) => {
    await page.goto(`/${seed.prefix}/apps`);
    const row = page.locator("tbody tr", { hasText: "Bla" });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.getByText("Not connected")).toBeVisible();
    await expect(row.getByRole("button", { name: "Connect" })).toBeVisible();

    await row.click();
    await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/apps/app/${applicationId}/setup$`), { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "Bla" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "Previous setup" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Reconnect this app" })).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/apps-nav-w6-01-app-not-connected.png`, fullPage: true });
  });

  test("reconnect prefills the wizard and revives the same application", async ({ page, request }) => {
    await page.goto(`/${seed.prefix}/apps/app/${applicationId}`);
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(page).toHaveURL(/\/apps\/connect\?/, { timeout: 20_000 });
    await expect(page.getByText("Connect with a link")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(mock.url)).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/apps-nav-w6-02-reconnect-prefilled.png`, fullPage: true });

    await page.getByRole("button", { name: "Check link" }).click();
    await expect(page.getByText(/Connected to .* it offers/)).toBeVisible({ timeout: 30_000 });

    const apps = await request.get(`/api/companies/${seed.companyId}/tools/applications`);
    const appsBody = await apps.json();
    const matching = (appsBody.applications as Array<{ id: string; name: string }>).filter(
      (app) => app.name === "Bla",
    );
    expect(matching).toHaveLength(1);
    expect(matching[0].id).toBe(applicationId);

    const conns = await request.get(`/api/companies/${seed.companyId}/tools/connections`);
    const connsBody = await conns.json();
    const appConns = (connsBody.connections as Array<{ id: string; applicationId: string; status: string }>).filter(
      (c) => c.applicationId === applicationId,
    );
    expect(appConns).toHaveLength(1);
    expect(appConns[0].id).toBe(connectionId);
    expect(appConns[0].status).not.toBe("archived");
  });

  test("connected app page redirects from the app route and its row says Open", async ({ page }) => {
    await page.goto(`/${seed.prefix}/apps/app/${applicationId}`);
    await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/apps/${connectionId}/setup$`), { timeout: 20_000 });

    await page.goto(`/${seed.prefix}/apps`);
    const row = page.locator("tbody tr", { hasText: "Bla" });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.getByRole("button", { name: /Open|Review/ })).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/apps-nav-w6-03-reconnected-row.png`, fullPage: true });
  });

  test("danger zone on the app page removes the app", async ({ page, request }) => {
    // Build a second not-connected app to remove from its app page.
    const second = await request.post(`/api/companies/${seed.companyId}/tools/apps/connect`, {
      data: {
        link: mock.url.replace("127.0.0.1", "localhost"),
        name: "Doomed app",
        credentialValues: { "credentials.authorization": "qa-token" },
      },
    });
    expect(second.ok(), `second connect failed ${second.status()}: ${await second.text()}`).toBe(true);
    const secondBody = await second.json();
    await request.delete(`/api/tool-connections/${secondBody.connectionId}`);
    await request.patch(`/api/tool-applications/${secondBody.application.id}`, { data: { status: "active" } });

    await page.goto(`/${seed.prefix}/apps/app/${secondBody.application.id}/advanced`);
    await expect(page.getByText("Danger zone")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Remove app", exact: true }).click();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/apps-nav-w6-04-app-page-danger.png`, fullPage: true });
    await page.getByRole("button", { name: "Yes, remove it" }).click();
    await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/apps$`), { timeout: 20_000 });
    await expect(page.getByText("App removed").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("tbody tr", { hasText: "Doomed app" })).toHaveCount(0);
  });
});
