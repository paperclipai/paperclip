import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

// PAP-10915 — dark-mode + navigation QA for the prosumer Apps surfaces.
// Seeds a healthy app and a broken (needs-attention) app, forces dark theme,
// and screenshots /apps, /apps/attention, and the Advanced door (M8 tabs +
// developer tabs) to prove the amber/emerald surfaces read correctly on dark.

const SCREENSHOT_DIR = "test-results";

type Seed = { companyId: string; prefix: string };

async function newCompany(request: APIRequestContext, label: string): Promise<Seed> {
  const res = await request.post("/api/companies", { data: { name: `PAP-10915 ${label} ${Date.now()}` } });
  expect(res.ok(), `create company failed ${res.status()}: ${await res.text()}`).toBe(true);
  const company = await res.json();
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
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
  return body.connectionId as string;
}

async function forceDark(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("paperclip.theme", "dark"));
}

test.describe.serial("PAP-10915 dark-mode Apps surfaces", () => {
  test.setTimeout(240_000);

  let healthy: MockMcpServer;
  let seed: Seed;

  test.beforeAll(async ({ request }) => {
    healthy = await startMockMcp();
    seed = await newCompany(request, "dark");

    // Healthy app.
    await connectApp(request, seed, healthy.url);

    // Broken app → needs attention. Use a `localhost` URL so the derived
    // connection name differs from the healthy `127.0.0.1` app.
    const ephemeral = await startMockMcp();
    const brokenId = await connectApp(request, seed, ephemeral.url.replace("127.0.0.1", "localhost"));
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
    await expect(page.getByRole("heading", { name: "Apps" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/needs attention/i).first()).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/pap10915-01-apps-dark.png`, fullPage: true });
  });

  test("needs attention page dark mode", async ({ page }) => {
    await forceDark(page);
    await page.goto(`/${seed.prefix}/apps/attention`);
    await expect(page.getByRole("heading", { name: "Needs attention" })).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/pap10915-02-attention-dark.png`, fullPage: true });
  });

  test("advanced door defaults to Paste a config with Apps sidebar", async ({ page }) => {
    await forceDark(page);
    await page.goto(`/${seed.prefix}/apps/advanced`);
    await expect(page.getByRole("heading", { name: "Advanced setup" })).toBeVisible({ timeout: 30_000 });
    // M8a tab switcher with paste-config active; Apps secondary sidebar present.
    await expect(page.getByRole("link", { name: "Paste a config" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Run your own" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Needs attention" })).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/pap10915-03-advanced-paste-dark.png`, fullPage: true });

    await page.getByRole("link", { name: "Run your own" }).click();
    await expect(page.getByText(/isolated workspace/i).first()).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/pap10915-04-advanced-run-dark.png`, fullPage: true });
  });

  test("developer tabs keep the developer sidebar", async ({ page }) => {
    await forceDark(page);
    await page.goto(`/${seed.prefix}/apps/advanced/applications`);
    await expect(page.getByRole("heading", { name: "Developer tools" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("link", { name: "Runtime", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Audit", exact: true })).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/pap10915-05-developer-overview-dark.png`, fullPage: true });
  });
});
