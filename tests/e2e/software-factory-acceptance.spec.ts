import {
  expect,
  request as playwrightRequest,
  test,
  type APIResponse,
  type APIRequestContext,
  type Page,
  type Request,
  type Response,
} from "@playwright/test";

/**
 * FAS-119 / ALL-388: deterministic software-factory browser acceptance.
 *
 * Run only this bounded suite with:
 *   pnpm test:e2e:factory
 *
 * The shared Playwright config boots a fresh loopback-only Paperclip instance
 * in a temporary PAPERCLIP_HOME. This suite never reads live credentials and
 * fails on any browser request that leaves the loopback instance.
 */

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const COMPANY_NAME = "FAS119 Software Factory";
const WORKER_NAME = "FAS119 Automation Worker";
const TERMINAL_ISSUE_TITLE = "FAS119 checkout to terminal acceptance";
const BLOCKED_ISSUE_TITLE = "FAS119 blocked dependency acceptance";
const EVIDENCE_COMMENT = "FAS119 deterministic browser evidence is attached.";
const EVIDENCE_TITLE = "FAS119 local acceptance evidence";

// Synthetic canaries deliberately look like credentials. They prove that
// response projections, DOM rendering, and browser-observable logs/network
// artifacts do not expose persisted runtime secret material.
const SECRET_CANARIES = [
  "pc_live_FAS119_NEVER_EXPOSE_AUTH_TOKEN",
  "FAS119_NEVER_EXPOSE_PRIVATE_KEY_MATERIAL",
  "sk-fas119-NEVER-EXPOSE-PROVIDER-KEY",
  "FAS119_NEVER_EXPOSE_SESSION_COOKIE",
] as const;

type Fixture = {
  board: APIRequestContext;
  companyId: string;
  prefix: string;
  agentId: string;
  terminalIssueId: string;
  terminalIssueIdentifier: string;
  blockedIssueIdentifier: string;
};

type BrowserLeakMonitor = {
  externalRequests: string[];
  leakFindings: string[];
  responseChecks: Promise<void>[];
};

function findCanary(value: string): string | null {
  return SECRET_CANARIES.find((canary) => value.includes(canary)) ?? null;
}

function isLoopbackBrowserUrl(value: string): boolean {
  const url = new URL(value);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return true;
  return url.hostname === "127.0.0.1";
}

function assertResponseSafe(label: string, value: unknown) {
  const serialized = JSON.stringify(value);
  const leaked = findCanary(serialized);
  expect(leaked, `${label} exposed synthetic runtime credential material`).toBeNull();
}

async function expectOk(response: APIResponse, label: string) {
  if (!response.ok()) {
    throw new Error(`${label} failed (${response.status()}): ${await response.text()}`);
  }
  const body = await response.json();
  assertResponseSafe(label, body);
  return body;
}

async function installBrowserLeakMonitor(page: Page): Promise<BrowserLeakMonitor> {
  const monitor: BrowserLeakMonitor = {
    externalRequests: [],
    leakFindings: [],
    responseChecks: [],
  };

  await page.routeWebSocket(/.*/, async (webSocket) => {
    const url = webSocket.url();
    if (!isLoopbackBrowserUrl(url)) {
      monitor.externalRequests.push(url);
      await webSocket.close({ code: 1008, reason: "Browser acceptance permits only 127.0.0.1" });
      return;
    }
    webSocket.connectToServer();
  });

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!isLoopbackBrowserUrl(url.toString())) {
      monitor.externalRequests.push(url.toString());
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  page.on("request", (request: Request) => {
    const requestArtifact = JSON.stringify({
      url: request.url(),
      headers: request.headers(),
      postData: request.postData(),
    });
    const leaked = findCanary(requestArtifact);
    if (leaked) monitor.leakFindings.push(`request ${request.method()} ${request.url()} leaked ${leaked}`);
  });

  page.on("response", (response: Response) => {
    const check = (async () => {
      const contentType = response.headers()["content-type"] ?? "";
      const headerArtifact = JSON.stringify({ url: response.url(), headers: response.headers() });
      const headerLeak = findCanary(headerArtifact);
      if (headerLeak) monitor.leakFindings.push(`response headers ${response.url()} leaked ${headerLeak}`);
      if (!/(?:json|text|javascript|css|html)/i.test(contentType)) return;
      const body = await response.text().catch(() => "");
      const bodyLeak = findCanary(body);
      if (bodyLeak) monitor.leakFindings.push(`response body ${response.url()} leaked ${bodyLeak}`);
    })();
    monitor.responseChecks.push(check);
  });

  page.on("websocket", (webSocket) => {
    if (!isLoopbackBrowserUrl(webSocket.url())) {
      monitor.externalRequests.push(webSocket.url());
    }
    const inspectFrame = (direction: "sent" | "received", payload: string | Buffer) => {
      const leaked = findCanary(payload.toString());
      if (leaked) monitor.leakFindings.push(`websocket frame ${direction} ${webSocket.url()} leaked ${leaked}`);
    };
    webSocket.on("framesent", ({ payload }) => inspectFrame("sent", payload));
    webSocket.on("framereceived", ({ payload }) => inspectFrame("received", payload));
  });

  page.on("console", (message) => {
    const leaked = findCanary(message.text());
    if (leaked) monitor.leakFindings.push(`console ${message.type()} leaked ${leaked}`);
  });
  page.on("pageerror", (error) => {
    const leaked = findCanary(error.stack ?? error.message);
    if (leaked) monitor.leakFindings.push(`page error leaked ${leaked}`);
  });

  return monitor;
}

async function assertNoBrowserLeaks(page: Page, monitor: BrowserLeakMonitor) {
  await Promise.all(monitor.responseChecks);
  const dom = await page.locator("html").evaluate((element) => element.outerHTML);
  const domLeak = findCanary(dom);
  if (domLeak) monitor.leakFindings.push(`DOM leaked ${domLeak}`);
  expect(monitor.externalRequests, "browser attempted non-loopback network access").toEqual([]);
  expect(monitor.leakFindings, "secret canaries appeared in browser artifacts").toEqual([]);
}

test("loopback monitor classifies HTTP and WebSocket transports", () => {
  expect(isLoopbackBrowserUrl("http://127.0.0.1:3199/api/health")).toBe(true);
  expect(isLoopbackBrowserUrl("https://127.0.0.1:3199/api/health")).toBe(true);
  expect(isLoopbackBrowserUrl("ws://127.0.0.1:3199/api/live")).toBe(true);
  expect(isLoopbackBrowserUrl("wss://127.0.0.1:3199/api/live")).toBe(true);
  expect(isLoopbackBrowserUrl("ws://example.com/socket")).toBe(false);
  expect(isLoopbackBrowserUrl("wss://example.com/socket")).toBe(false);
});

test("loopback monitor records WebSocket attempts outside the dedicated host", async ({ page }) => {
  const monitor = await installBrowserLeakMonitor(page);
  const socketUrl = `ws://localhost:${PORT}/api/live`;

  await page.goto("data:text/html,<title>websocket monitor probe</title>");
  await page.evaluate((url) => {
    new WebSocket(url);
  }, socketUrl);

  await expect.poll(() => monitor.externalRequests).toContain(socketUrl);
});

test.describe("software factory browser acceptance", () => {
  test.describe.configure({ mode: "serial" });
  let fixture: Fixture;

  test.beforeAll(async () => {
    const board = await playwrightRequest.newContext({ baseURL: BASE_URL });

    const health = await expectOk(await board.get("/api/health"), "health preflight");
    expect(health.deploymentMode).toBe("local_trusted");

    const company = await expectOk(
      await board.post("/api/companies", { data: { name: COMPANY_NAME } }),
      "company creation",
    );
    const companyId = String(company.id);
    const prefix = String(company.issuePrefix ?? company.prefix ?? company.urlKey);
    expect(prefix).not.toBe("");

    const agent = await expectOk(
      await board.post(`/api/companies/${companyId}/agents`, {
        data: {
          name: WORKER_NAME,
          role: "engineer",
          title: "Deterministic Browser Worker",
          adapterType: "process",
          adapterConfig: {
            command: process.execPath,
            args: ["-e", "process.stdout.write('fas119 fixture complete\\n')"],
            authToken: SECRET_CANARIES[0],
            devicePrivateKeyPem: SECRET_CANARIES[1],
            env: {
              PROVIDER_API_KEY: SECRET_CANARIES[2],
              SAFE_FIXTURE_SETTING: "fas119-safe",
            },
          },
          runtimeConfig: {
            heartbeat: { enabled: false },
            sessionCookie: SECRET_CANARIES[3],
          },
          metadata: { fixture: "FAS-119", credentials: { cookie: SECRET_CANARIES[3] } },
        },
      }),
      "agent creation response",
    );
    const agentId = String(agent.id);
    expect(agent.adapterConfig).not.toHaveProperty("authToken");
    expect(agent.adapterConfig).not.toHaveProperty("devicePrivateKeyPem");
    expect(agent.runtimeConfig).not.toHaveProperty("sessionCookie");
    const pausedAgent = await expectOk(
      await board.patch(`/api/agents/${agentId}`, { data: { status: "paused" } }),
      "fixture agent pause",
    );
    expect(pausedAgent.status).toBe("paused");

    const terminalIssue = await expectOk(
      await board.post(`/api/companies/${companyId}/issues`, {
        data: {
          title: TERMINAL_ISSUE_TITLE,
          status: "todo",
          priority: "high",
          assigneeAgentId: agentId,
        },
      }),
      "terminal issue creation",
    );

    const blocker = await expectOk(
      await board.post(`/api/companies/${companyId}/issues`, {
        data: { title: "FAS119 unresolved local blocker", status: "todo", priority: "medium" },
      }),
      "blocker creation",
    );
    const blockedIssue = await expectOk(
      await board.post(`/api/companies/${companyId}/issues`, {
        data: {
          title: BLOCKED_ISSUE_TITLE,
          status: "blocked",
          priority: "critical",
          assigneeAgentId: agentId,
          blockedByIssueIds: [blocker.id],
        },
      }),
      "blocked issue creation",
    );

    fixture = {
      board,
      companyId,
      prefix,
      agentId,
      terminalIssueId: String(terminalIssue.id),
      terminalIssueIdentifier: String(terminalIssue.identifier),
      blockedIssueIdentifier: String(blockedIssue.identifier),
    };
  });

  test.afterAll(async () => {
    await fixture?.board.dispose();
  });

  test("loads the board and keeps agent list/detail responses and UI response-safe", async ({ page }) => {
    const monitor = await installBrowserLeakMonitor(page);

    await page.goto(`/${fixture.prefix}/dashboard`);
    await expect(page.locator("body")).toContainText(COMPANY_NAME);

    await page.goto(`/${fixture.prefix}/agents/all`);
    await expect(page.getByText(WORKER_NAME).first()).toBeVisible();

    await page.goto(`/${fixture.prefix}/agents/${fixture.agentId}/configuration`);
    await expect(page.getByText(WORKER_NAME).first()).toBeVisible();

    const list = await expectOk(
      await fixture.board.get(`/api/companies/${fixture.companyId}/agents`),
      "agent list projection",
    );
    const listedAgent = list.find((candidate: { id: string }) => candidate.id === fixture.agentId);
    expect(listedAgent).toBeTruthy();
    expect(listedAgent.adapterConfig).not.toHaveProperty("authToken");

    const detail = await expectOk(
      await fixture.board.get(`/api/agents/${fixture.agentId}`),
      "agent detail projection",
    );
    expect(detail.adapterConfig).not.toHaveProperty("devicePrivateKeyPem");
    expect(detail.runtimeConfig).not.toHaveProperty("sessionCookie");

    await assertNoBrowserLeaks(page, monitor);
  });

  test("shows assignment, checkout, evidence, and the terminal issue state", async ({ page }) => {
    const monitor = await installBrowserLeakMonitor(page);

    const checkedOut = await expectOk(
      await fixture.board.post(`/api/issues/${fixture.terminalIssueId}/checkout`, {
        data: { agentId: fixture.agentId, expectedStatuses: ["todo"] },
      }),
      "issue checkout",
    );
    expect(checkedOut.status).toBe("in_progress");
    expect(checkedOut.assigneeAgentId).toBe(fixture.agentId);

    await page.goto(`/${fixture.prefix}/issues/${fixture.terminalIssueIdentifier}`);
    await expect(page.getByText(TERMINAL_ISSUE_TITLE).first()).toBeVisible();
    await expect(page.locator("body")).toContainText(/In progress/i);

    await expectOk(
      await fixture.board.post(`/api/issues/${fixture.terminalIssueId}/comments`, {
        data: { body: EVIDENCE_COMMENT },
      }),
      "evidence comment creation",
    );
    const evidence = await expectOk(
      await fixture.board.post(`/api/issues/${fixture.terminalIssueId}/work-products`, {
        data: {
          type: "artifact",
          provider: "local_test_fixture",
          title: EVIDENCE_TITLE,
          status: "ready_for_review",
          summary: "Deterministic local-only acceptance evidence.",
          metadata: { fixture: "FAS-119" },
        },
      }),
      "evidence work product creation",
    );
    expect(evidence.title).toBe(EVIDENCE_TITLE);
    expect(evidence.status).toBe("ready_for_review");
    const terminal = await expectOk(
      await fixture.board.patch(`/api/issues/${fixture.terminalIssueId}`, {
        data: { status: "done", comment: "FAS119 terminal transition verified." },
      }),
      "terminal issue transition",
    );
    expect(terminal.status).toBe("done");

    await page.reload();
    await expect(page.locator("body")).toContainText(/Done/i);
    await expect(page.getByText(EVIDENCE_COMMENT).first()).toBeVisible();

    await assertNoBrowserLeaks(page, monitor);
  });

  test("renders explicit blocked and agent error states", async ({ page }) => {
    const monitor = await installBrowserLeakMonitor(page);

    await page.goto(`/${fixture.prefix}/issues/${fixture.blockedIssueIdentifier}`);
    await expect(page.getByText(BLOCKED_ISSUE_TITLE).first()).toBeVisible();
    await expect(page.locator("body")).toContainText(/Blocked/i);

    const erroredAgent = await expectOk(
      await fixture.board.patch(`/api/agents/${fixture.agentId}`, { data: { status: "error" } }),
      "agent error transition",
    );
    expect(erroredAgent.status).toBe("error");
    expect(erroredAgent.adapterConfig).not.toHaveProperty("authToken");

    await page.goto(`/${fixture.prefix}/agents/error`);
    await expect(page.getByText(WORKER_NAME).first()).toBeVisible();
    await expect(page.locator("body")).toContainText(/Error/i);

    await page.goto(`/${fixture.prefix}/agents/${fixture.agentId}/dashboard`);
    await expect(page.getByText(WORKER_NAME).first()).toBeVisible();
    await expect(page.locator("body")).toContainText(/Error/i);

    await assertNoBrowserLeaks(page, monitor);
  });
});
