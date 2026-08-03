import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { listenOnFetchAllowedPort } from "./fetch-allowed-port";
import { storyById } from "./mcp-user-stories.catalog";

const SCREENSHOT_DIR = "test-results/mcp-user-stories";

type Seed = { companyId: string; prefix: string };
type Scout = { id: string; name: string };
type Json = Record<string, unknown>;
type MockMcpServer = {
  url: string;
  captures: Array<{ method: string; toolName: string | null; params: unknown }>;
  close: () => Promise<void>;
};
type HeartbeatRun = { id: string; status: string; error?: string | null };

async function json<T = Json>(response: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<T> {
  expect(response.ok(), `${response.url()} failed ${response.status()}: ${await response.text()}`).toBe(true);
  return await response.json() as T;
}

async function newCompany(request: APIRequestContext, label: string): Promise<Seed> {
  const body = await json<{ id: string; issuePrefix?: string; prefix?: string; urlKey?: string }>(
    await request.post("/api/companies", { data: { name: `MCP US ${label} ${Date.now()}` } }),
  );
  await json(await request.patch("/api/instance/settings/experimental", { data: { enableApps: true } }));
  return { companyId: body.id, prefix: body.issuePrefix ?? body.prefix ?? body.urlKey ?? "E2E" };
}

async function createScout(request: APIRequestContext, companyId: string): Promise<Scout> {
  const body = await json<{ id: string; name: string }>(
    await request.post(`/api/companies/${companyId}/agents`, {
      data: {
        name: `Scout ${Date.now()}`,
        role: "qa",
        title: "MCP story scout",
        capabilities: "Runs governed MCP user-story fixture calls.",
        adapterType: "process",
        adapterConfig: { command: "node", args: ["-e", "process.exit(0)"] },
      },
    }),
  );
  return { id: body.id, name: body.name };
}

function buildGatewayCallScript(connectionId: string, toolName: string, parameters: Json = {}) {
  return `
const required = ["PAPERCLIP_API_URL", "PAPERCLIP_API_KEY", "PAPERCLIP_RUN_ID"];
for (const key of required) {
  if (!process.env[key]) throw new Error(\`Missing \${key}\`);
}
const headers = {
  "authorization": \`Bearer \${process.env.PAPERCLIP_API_KEY}\`,
  "content-type": "application/json"
};
const sessionRes = await fetch(\`\${process.env.PAPERCLIP_API_URL}/api/tool-gateway/sessions\`, {
  method: "POST",
  headers,
  body: JSON.stringify({ runId: process.env.PAPERCLIP_RUN_ID, ttlMs: 60000 })
});
if (!sessionRes.ok) throw new Error(\`session \${sessionRes.status}: \${await sessionRes.text()}\`);
const session = await sessionRes.json();
const toolsRes = await fetch(\`\${process.env.PAPERCLIP_API_URL}/api/tool-gateway/tools\`, {
  headers: { "x-paperclip-tool-gateway-token": session.token }
});
if (!toolsRes.ok) throw new Error(\`tools \${toolsRes.status}: \${await toolsRes.text()}\`);
const tools = await toolsRes.json();
const tool = tools.find((entry) =>
  entry.connectionId === ${JSON.stringify(connectionId)}
  && (entry.upstreamToolName === ${JSON.stringify(toolName)} || entry.name === ${JSON.stringify(toolName)})
);
if (!tool) throw new Error(\`Missing gateway tool for ${toolName}\`);
const callRes = await fetch(\`\${process.env.PAPERCLIP_API_URL}/api/tool-gateway/tools/call\`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-paperclip-tool-gateway-token": session.token
  },
  body: JSON.stringify({
    tool: tool.name,
    parameters: ${JSON.stringify(parameters)}
  })
});
const text = await callRes.text();
if (!callRes.ok) throw new Error(\`tool call \${callRes.status}: \${text}\`);
console.log(text);
`;
}

async function setScoutScript(
  request: APIRequestContext,
  scout: Scout,
  script: string,
) {
  await json(await request.patch(`/api/agents/${scout.id}`, {
    data: {
      adapterConfig: {
        command: process.execPath,
        args: ["--input-type=module", "-e", script],
      },
      replaceAdapterConfig: true,
    },
  }));
}

async function invokeHeartbeat(request: APIRequestContext, agentId: string) {
  return await json<HeartbeatRun>(await request.post(`/api/agents/${agentId}/heartbeat/invoke`));
}

async function waitForRun(request: APIRequestContext, runId: string) {
  for (let i = 0; i < 60; i += 1) {
    const run = await json<HeartbeatRun>(await request.get(`/api/heartbeat-runs/${runId}`));
    if (!["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for heartbeat run ${runId}`);
}

async function startMockMcp(): Promise<MockMcpServer> {
  const captures: MockMcpServer["captures"] = [];
  const server: Server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
      id?: string | number;
      method?: string;
      params?: { name?: string; arguments?: unknown };
    };
    const toolName = payload.params?.name ?? null;
    captures.push({ method: String(payload.method ?? "<unknown>"), toolName, params: payload.params ?? null });

    if (payload.method === "tools/list") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id ?? null,
        result: {
          tools: [
            {
              name: "sheets:list_rows",
              title: "List sheet rows",
              description: "Read rows from the deterministic Sheets fixture.",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
            {
              name: "sheets:update_cell",
              title: "Update sheet cell",
              description: "Updates one deterministic sheet cell.",
              inputSchema: {
                type: "object",
                properties: { cell: { type: "string" }, value: { type: "string" } },
                required: ["cell", "value"],
                additionalProperties: false,
              },
            },
            {
              name: "sheets:delete_row",
              title: "Delete sheet row",
              description: "Deletes one deterministic sheet row.",
              inputSchema: {
                type: "object",
                properties: { row: { type: "number" } },
                required: ["row"],
                additionalProperties: false,
              },
            },
          ],
        },
      }));
      return;
    }
    if (payload.method === "tools/call") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id ?? null,
        result: { content: [{ type: "text", text: `${toolName ?? "tool"} ok` }] },
      }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id ?? null, result: {} }));
  });
  const port = await listenOnFetchAllowedPort(server);
  return {
    url: `http://127.0.0.1:${port}/`,
    captures,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function screenshot(page: Page, storyId: string, step: string) {
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${storyId.toLowerCase()}-${step}.png`, fullPage: true });
}

async function seedConnectedFixture(request: APIRequestContext, label: string) {
  const seed = await newCompany(request, label);
  const scout = await createScout(request, seed.companyId);
  const mock = await startMockMcp();
  const connect = await json<{
    connectionId: string;
    catalog: Array<{ id: string; toolName: string; riskLevel?: string | null }>;
  }>(await request.post(`/api/companies/${seed.companyId}/tools/apps/connect`, {
    data: { link: mock.url, name: `Sheets Fixture ${label}` },
  }));
  const enabled = connect.catalog.map((entry) => entry.id);
  const askFirst = connect.catalog
    .filter((entry) => /update|delete|create|send|write/i.test(entry.toolName) || entry.riskLevel === "write" || entry.riskLevel === "destructive")
    .map((entry) => entry.id);
  await json(await request.post(`/api/companies/${seed.companyId}/tools/apps/${connect.connectionId}/finish`, {
    data: {
      enabledCatalogEntryIds: enabled,
      askFirstCatalogEntryIds: askFirst,
      access: { agentIds: [scout.id] },
    },
  }));
  return { seed, scout, mock, connectionId: connect.connectionId };
}

async function testCall(
  request: APIRequestContext,
  connectionId: string,
  scout: Scout,
  toolName: string,
  parameters: Json = {},
) {
  return await json<{
    decision: "allowed" | "ask_first" | "off";
    invocationId: string;
    actionRequestId?: string;
    result?: unknown;
    error?: { reasonCode?: string | null; message: string };
  }>(await request.post(`/api/tool-connections/${connectionId}/test-calls`, {
    data: { agentId: scout.id, toolName, parameters },
  }));
}

async function approveActionRequest(request: APIRequestContext, companyId: string, actionRequestId: string) {
  return await json(await request.post(`/api/tool-gateway/action-requests/${actionRequestId}/approve`, {
    data: { companyId },
  }));
}

async function declineActionRequest(request: APIRequestContext, companyId: string, actionRequestId: string) {
  return await json(await request.post(`/api/tool-gateway/action-requests/${actionRequestId}/decline`, {
    data: { companyId },
  }));
}

async function pollTestCall(
  request: APIRequestContext,
  connectionId: string,
  actionRequestId: string,
  expectedPhase: string,
) {
  for (let i = 0; i < 20; i += 1) {
    const status = await json<{ phase: string }>(
      await request.get(`/api/tool-connections/${connectionId}/test-calls/${actionRequestId}`),
    );
    if (status.phase === expectedPhase) return status;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for test-call ${actionRequestId} phase ${expectedPhase}`);
}

async function expectAuditEvent(
  request: APIRequestContext,
  companyId: string,
  options: { connectionId: string; agentId: string; search: string },
) {
  const audit = await json<{ events: Array<Json> }>(
    await request.get(
      `/api/tool-gateway/audit?companyId=${companyId}&app=${options.connectionId}&agent=${options.agentId}&search=${encodeURIComponent(options.search)}&limit=50`,
    ),
  );
  expect(audit.events.length, `expected audit/activity row matching ${options.search}`).toBeGreaterThan(0);
}

test.describe.serial("MCP prod Phase 5a user-story harness", () => {
  test.setTimeout(180_000);

  test(`${storyById("US-1").id} ${storyById("US-1").title} @mcp-runnable @mcp-us1`, async ({ page, request }) => {
    const { seed, scout, mock, connectionId } = await seedConnectedFixture(request, "us1");
    try {
      await page.goto(`/${seed.prefix}/apps/${connectionId}`);
      await expect(page.getByRole("heading", { name: /Sheets Fixture us1/i })).toBeVisible({ timeout: 30_000 });
      await screenshot(page, "US-1", "01-connected-app");

      await setScoutScript(request, scout, buildGatewayCallScript(connectionId, "sheets:list_rows"));
      const invoked = await invokeHeartbeat(request, scout.id);
      const run = await waitForRun(request, invoked.id);
      expect(run.status, run.error ?? `heartbeat run ${run.id} did not succeed`).toBe("succeeded");
      expect(mock.captures.some((capture) => capture.method === "tools/call" && capture.toolName === "sheets:list_rows")).toBe(true);
      await expectAuditEvent(request, seed.companyId, { connectionId, agentId: scout.id, search: "sheets:list_rows" });

      await page.goto(`/${seed.prefix}/apps/${connectionId}/activity`);
      await screenshot(page, "US-1", "02-activity");
    } finally {
      await mock.close();
    }
  });

  test(`${storyById("US-2").id} ${storyById("US-2").title} @mcp-runnable @mcp-us2`, async ({ page, request }) => {
    const { seed, scout, mock, connectionId } = await seedConnectedFixture(request, "us2");
    try {
      const pending = await testCall(request, connectionId, scout, "sheets:update_cell", { cell: "A1", value: "approved" });
      expect(pending.decision).toBe("ask_first");
      expect(pending.actionRequestId).toBeTruthy();

      await page.goto(`/${seed.prefix}/apps/${connectionId}/review`);
      await screenshot(page, "US-2", "01-review-pending");

      await approveActionRequest(request, seed.companyId, pending.actionRequestId!);
      await pollTestCall(request, connectionId, pending.actionRequestId!, "done");
      expect(mock.captures.filter((capture) => capture.method === "tools/call" && capture.toolName === "sheets:update_cell")).toHaveLength(1);
      await expectAuditEvent(request, seed.companyId, { connectionId, agentId: scout.id, search: "sheets:update_cell" });
    } finally {
      await mock.close();
    }
  });

  test(`${storyById("US-3").id} ${storyById("US-3").title} @mcp-runnable @mcp-us3`, async ({ page, request }) => {
    const { seed, scout, mock, connectionId } = await seedConnectedFixture(request, "us3");
    try {
      const pending = await testCall(request, connectionId, scout, "sheets:update_cell", { cell: "A2", value: "denied" });
      expect(pending.actionRequestId).toBeTruthy();
      await declineActionRequest(request, seed.companyId, pending.actionRequestId!);
      await pollTestCall(request, connectionId, pending.actionRequestId!, "denied");
      expect(mock.captures.some((capture) => capture.method === "tools/call" && capture.toolName === "sheets:update_cell")).toBe(false);

      await page.goto(`/${seed.prefix}/apps/${connectionId}/review`);
      await screenshot(page, "US-3", "01-review-denied");
    } finally {
      await mock.close();
    }
  });

  test(`${storyById("US-4").id} ${storyById("US-4").title} @mcp-runnable @mcp-us4`, async ({ page, request }) => {
    const { seed, scout, mock, connectionId } = await seedConnectedFixture(request, "us4");
    try {
      const block = await json<{ id: string }>(await request.post(`/api/companies/${seed.companyId}/tools/policies`, {
        data: {
          name: "US-4 block fixture connection",
          policyType: "block",
          priority: 1,
          selectors: { connectionId },
        },
      }));
      const denied = await testCall(request, connectionId, scout, "sheets:list_rows");
      expect(denied.decision).toBe("off");
      expect(denied.error?.reasonCode).toBeTruthy();

      await json(await request.patch(`/api/companies/${seed.companyId}/tools/policies/${block.id}`, {
        data: { enabled: false },
      }));
      const allowed = await testCall(request, connectionId, scout, "sheets:list_rows");
      expect(allowed.decision).toBe("allowed");
      await expectAuditEvent(request, seed.companyId, { connectionId, agentId: scout.id, search: "sheets:list_rows" });

      await page.goto(`/${seed.prefix}/apps/advanced/policies`);
      await screenshot(page, "US-4", "01-policy-flip");
    } finally {
      await mock.close();
    }
  });

  test(`${storyById("US-5").id} ${storyById("US-5").title} @mcp-runnable @mcp-us5`, async ({ page, request }) => {
    const { seed, scout, mock, connectionId } = await seedConnectedFixture(request, "us5");
    try {
      const catalog = await json<{ catalog: Array<{ toolName: string }> }>(
        await request.get(`/api/tool-connections/${connectionId}/catalog`),
      );
      expect(catalog.catalog.map((entry) => entry.toolName)).toEqual(expect.arrayContaining([
        "sheets:list_rows",
        "sheets:update_cell",
      ]));
      const read = await testCall(request, connectionId, scout, "sheets:list_rows");
      expect(read.decision).toBe("allowed");

      await page.goto(`/${seed.prefix}/apps/connect`);
      await screenshot(page, "US-5", "01-connect-your-own-entry");
    } finally {
      await mock.close();
    }
  });

  test(`${storyById("US-6").id} ${storyById("US-6").title} @mcp-us6`, async () => {
    test.skip(true, storyById("US-6").gate);
  });

  test(`${storyById("US-7").id} ${storyById("US-7").title} @mcp-us7`, async () => {
    test.skip(true, storyById("US-7").gate);
  });

  test(`${storyById("US-8").id} ${storyById("US-8").title} @mcp-runnable @mcp-us8`, async ({ page, request }) => {
    const { seed, mock, connectionId } = await seedConnectedFixture(request, "us8");
    await mock.close();

    const health = await request.post(`/api/tool-connections/${connectionId}/health-check`);
    expect(health.status()).toBe(502);
    await page.goto(`/${seed.prefix}/apps`);
    await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible({ timeout: 30_000 });
    await screenshot(page, "US-8", "01-needs-attention");

    const recovered = await startMockMcp();
    try {
      await json(await request.patch(`/api/tool-connections/${connectionId}`, {
        data: { config: { url: recovered.url } },
      }));
      await json(await request.post(`/api/tool-connections/${connectionId}/reconnect`, {
        data: { credentialValues: { "credentials.authorization": "fresh-fixture-key" } },
      }));
      const after = await json<{ healthStatus: string }>(await request.get(`/api/tool-connections/${connectionId}`));
      expect(after.healthStatus).toBe("ok");
      await page.goto(`/${seed.prefix}/apps/${connectionId}`);
      await screenshot(page, "US-8", "02-recovered");
    } finally {
      await recovered.close();
    }
  });

  test(`${storyById("US-9").id} ${storyById("US-9").title} @mcp-runnable @mcp-us9`, async ({ page, request }) => {
    const { seed, scout, mock, connectionId } = await seedConnectedFixture(request, "us9");
    try {
      for (const value of ["first", "second"]) {
        const pending = await testCall(request, connectionId, scout, "sheets:update_cell", { cell: "B1", value });
        expect(pending.decision).toBe("ask_first");
        await page.goto(`/${seed.prefix}/apps/${connectionId}/review`);
        await screenshot(page, "US-9", `review-${value}`);
        await approveActionRequest(request, seed.companyId, pending.actionRequestId!);
        await pollTestCall(request, connectionId, pending.actionRequestId!, "done");
      }
      expect(mock.captures.filter((capture) => capture.method === "tools/call" && capture.toolName === "sheets:update_cell")).toHaveLength(2);
    } finally {
      await mock.close();
    }
  });

  test(`${storyById("US-10").id} ${storyById("US-10").title} @mcp-runnable @mcp-us10`, async ({ page, request }) => {
    const { seed, mock, connectionId } = await seedConnectedFixture(request, "us10");
    try {
      await page.goto(`/${seed.prefix}/apps/${connectionId}`);
      await expect(page.getByRole("heading", { name: /Sheets Fixture us10/i })).toBeVisible({ timeout: 30_000 });
      await screenshot(page, "US-10", "01-apps-detail");

      await page.goto(`/${seed.prefix}/apps/advanced`);
      await expect(page.getByRole("heading", { name: "Advanced setup" })).toBeVisible({ timeout: 20_000 });
      await screenshot(page, "US-10", "02-admin-depth");
    } finally {
      await mock.close();
    }
  });
});
