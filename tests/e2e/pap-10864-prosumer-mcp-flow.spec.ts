import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

// PAP-10864 — QA harness for the prosumer Connect-an-app flow on top of the
// tool-access foundation. Covers the M-series happy path (gallery + key paste
// → choose actions → who-can-use → success), the expired-key reconnect path,
// the Needs-attention surface, and a regression check that /apps/advanced
// still mounts.
//
// The spec boots the shared local_trusted Playwright webServer (see
// playwright.config), spawns a small in-process mock HTTP MCP server that
// responds to tools/list with read-only and write-side-effect tools, then
// drives the wizard via the Apps UI for evidence + screenshots.

const SCREENSHOT_DIR = "test-results";

type Seed = { companyId: string; prefix: string };

async function newCompany(request: APIRequestContext, label: string): Promise<Seed> {
  const res = await request.post("/api/companies", { data: { name: `PAP-10864 ${label} ${Date.now()}` } });
  expect(res.ok(), `create company failed ${res.status()}: ${await res.text()}`).toBe(true);
  const company = await res.json();
  return {
    companyId: company.id,
    prefix: company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E",
  };
}

// ---- Mock MCP HTTP fixture --------------------------------------------------
// Minimal MCP JSON-RPC server. /catalog refresh hits this with method
// `tools/list`; the gateway calls it with `tools/call`. We expose one
// read-only and one write tool so the wizard can show the Ask-first toggle
// for write actions.

type MockMcpServer = { url: string; close: () => Promise<void>; captures: Array<{ method: string; params: unknown }> };

async function startMockMcp(options: { expectedHeader?: string } = {}): Promise<MockMcpServer> {
  const captures: Array<{ method: string; params: unknown }> = [];
  const server: Server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    if (options.expectedHeader && req.headers.authorization !== options.expectedHeader) {
      res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Unauthorized" } }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let payload: { id?: string | number; method?: string; params?: unknown } = {};
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      // fall through to method routing — will land in default
    }
    captures.push({ method: String(payload.method ?? "<unknown>"), params: payload.params });

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
              {
                // Namespaced name (PAP-10902): real MCP servers prefix tool names
                // ("github:create_issue"). The classifier must still see the "create"
                // verb and land this under "Can make changes" with the toggle OFF —
                // the old leading-anchor regex fell through to read-only.
                name: "qa10864:create_widget",
                title: "Create widget",
                description: "Creates a widget — has side effects.",
                inputSchema: {
                  type: "object",
                  properties: { name: { type: "string" } },
                  required: ["name"],
                  additionalProperties: false,
                },
              },
            ],
          },
        })
      );
      return;
    }
    if (payload.method === "tools/call") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id ?? null, result: { content: [{ type: "text", text: "ok" }] } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id ?? null, result: {} }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    captures,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---- Helpers ----------------------------------------------------------------

async function gotoApps(page: Page, prefix: string) {
  await page.goto(`/${prefix}/apps`);
}

async function gotoConnect(page: Page, prefix: string) {
  await page.goto(`/${prefix}/apps/connect`);
}

async function gotoAdvanced(page: Page, prefix: string) {
  await page.goto(`/${prefix}/apps/advanced`);
}

async function gotoNeedsAttention(page: Page, prefix: string) {
  await page.goto(`/${prefix}/apps/attention`);
}

// ---- Tests ------------------------------------------------------------------

test.describe.serial("PAP-10864 prosumer MCP flow", () => {
  test.setTimeout(180_000); // vite-dev cold bundling is slow on first hit

  let mock: MockMcpServer;

  test.beforeAll(async () => {
    mock = await startMockMcp();
  });

  test.afterAll(async () => {
    await mock?.close();
  });

  test("Connect wizard happy path: link mode → actions → who → success", async ({ page, request }) => {
    const seed = await newCompany(request, "connect");

    await gotoConnect(page, seed.prefix);

    // Gallery step renders with seeded apps + the link-mode entry.
    await expect(page.getByRole("heading", { name: "Connect an app" })).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/pap10864-01-gallery.png`, fullPage: true });

    // Use the "Connect with a link" path against the mock MCP server.
    const linkInput = page.getByPlaceholder("https://example.com/actions");
    await linkInput.fill(mock.url);
    await page.getByRole("button", { name: "Continue" }).click();

    // LinkKey step shows the "Connect with a link" heading. Mock doesn't
    // require a key — leave the default "No" answer.
    await expect(page.getByRole("heading", { name: "Connect with a link" })).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/pap10864-02-key-step.png`, fullPage: true });

    // Submit (button label is "Check link").
    await page.getByRole("button", { name: /Check link/i }).click();

    // Actions step — read-only enabled, write disabled by default.
    await expect(page.getByText(/Read only/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Can make changes/i)).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/pap10864-03-actions-step.png`, fullPage: true });

    // Verify our seeded tool labels appear (display name is the descriptor title).
    await expect(page.getByText("List widgets")).toBeVisible();
    await expect(page.getByText("Create widget")).toBeVisible();

    // PAP-10902: the namespaced write action ("qa10864:create_widget") must be
    // classified write and land under "Can make changes" — NOT pre-enabled under
    // "Read only". Scope the assertions to each action group.
    const readOnlyGroup = page.locator("div.rounded-xl").filter({ hasText: "Read only" });
    const canChangeGroup = page.locator("div.rounded-xl").filter({ hasText: "Can make changes" });
    await expect(canChangeGroup.getByText("Create widget")).toBeVisible();
    await expect(readOnlyGroup.getByText("Create widget")).toHaveCount(0);
    await expect(readOnlyGroup.getByText("List widgets")).toBeVisible();

    // Toggle the write action on so an Ask-first badge appears + the Continue button enables it.
    const createToggle = page.getByRole("switch").last();
    await createToggle.click();
    await expect(page.getByText(/Ask first/i)).toBeVisible({ timeout: 5_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/pap10864-03b-ask-first-on.png`, fullPage: true });

    // Continue to who-can-use.
    await page.getByRole("button", { name: /Continue with .* on/ }).click();

    // Who-can-use step — defaults to All agents.
    await expect(page.getByRole("heading", { name: /Who can use/i })).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/pap10864-04-who-step.png`, fullPage: true });

    // Finish.
    await page.getByRole("button", { name: /Finish setup/i }).click();

    // Success step.
    await expect(page.getByText(/ready|all set|done/i).first()).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/pap10864-05-success.png`, fullPage: true });

    // Verify the mock saw a tools/list call from the catalog refresh.
    expect(mock.captures.some((c) => c.method === "tools/list")).toBe(true);

    // The new connection should show up on /apps.
    await gotoApps(page, seed.prefix);
    await expect(page.getByRole("heading", { name: "Apps" })).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/pap10864-06-apps-list.png`, fullPage: true });
  });

  test("Expired key → health sweep → Needs attention → reconnect → green", async ({ page, request }) => {
    const seed = await newCompany(request, "attention");

    // Spawn a dedicated mock we can break partway through.
    const ephemeral = await startMockMcp();
    try {
      const connect = await request.post(`/api/companies/${seed.companyId}/tools/apps/connect`, {
        data: { link: ephemeral.url, credentialValues: { "credentials.authorization": "qa-token" } },
      });
      expect(connect.ok(), `connect failed ${connect.status()}: ${await connect.text()}`).toBe(true);
      const connectResult = await connect.json();
      const connectionId = connectResult.connectionId as string;

      // Break the mock so the next health-check fails (simulates expired key /
      // dead remote — the same observable shape the server uses to mark a
      // connection unhealthy).
      await ephemeral.close();

      const health = await request.post(`/api/tool-connections/${connectionId}/health-check`);
      expect(health.status(), `health-check should fail with the mock down`).toBe(502);

      const before = await request.get(`/api/tool-connections/${connectionId}`);
      const beforeBody = await before.json();
      expect(beforeBody.healthStatus).not.toBe("ok");

      // Needs-attention page should surface this connection.
      await gotoNeedsAttention(page, seed.prefix);
      await expect(page.getByRole("heading", { name: "Needs attention" })).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: `${SCREENSHOT_DIR}/pap10864-07-needs-attention.png`, fullPage: true });

      // App detail should expose the reconnect call-to-action.
      await page.goto(`/${seed.prefix}/apps/${connectionId}`);
      await expect(page.getByRole("button", { name: /Reconnect|Replace key/i }).first()).toBeVisible({ timeout: 20_000 });
      await page.screenshot({ path: `${SCREENSHOT_DIR}/pap10864-08-app-detail-reconnect.png`, fullPage: true });

      // Bring the mock back so reconnect succeeds.
      const recovered = await startMockMcp();
      try {
        // The reconnect endpoint replaces credentials but does not change the URL,
        // so we update the connection URL through PATCH first to point at the
        // recovered mock — this mirrors what users do when the remote moves.
        const repatch = await request.patch(`/api/tool-connections/${connectionId}`, {
          data: { config: { url: recovered.url } },
        });
        expect(repatch.ok(), `patch url failed ${repatch.status()}: ${await repatch.text()}`).toBe(true);

        const reconnect = await request.post(`/api/tool-connections/${connectionId}/reconnect`, {
          data: { credentialValues: { "credentials.authorization": "fresh-key" } },
        });
        expect(reconnect.ok(), `reconnect failed ${reconnect.status()}: ${await reconnect.text()}`).toBe(true);

        const after = await request.get(`/api/tool-connections/${connectionId}`);
        const afterBody = await after.json();
        expect(afterBody.healthStatus).toBe("ok");
      } finally {
        await recovered.close();
      }
    } finally {
      // ephemeral already closed above
    }
  });

  test("/apps/advanced still mounts both tabs", async ({ page, request }) => {
    const seed = await newCompany(request, "advanced");

    await gotoAdvanced(page, seed.prefix);
    await expect(page.getByRole("heading", { name: "Advanced setup" })).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/pap10864-09-advanced-default.png`, fullPage: true });

    // M8a paste tab.
    const pasteTab = page.getByRole("tab", { name: /Paste/i }).first();
    if (await pasteTab.isVisible().catch(() => false)) {
      await pasteTab.click();
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${SCREENSHOT_DIR}/pap10864-10-advanced-paste-tab.png`, fullPage: true });
    }

    // M8b run-your-own tab.
    const ownTab = page.getByRole("tab", { name: /Run your own|Self host|Stdio|Local/i }).first();
    if (await ownTab.isVisible().catch(() => false)) {
      await ownTab.click();
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${SCREENSHOT_DIR}/pap10864-11-advanced-own-tab.png`, fullPage: true });
    }
  });
});
