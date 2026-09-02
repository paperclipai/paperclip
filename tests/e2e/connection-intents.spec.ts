import { expect, test, type APIRequestContext } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { listenOnFetchAllowedPort } from "./fetch-allowed-port";

type Json = Record<string, unknown>;
type Seed = { companyId: string; prefix: string };
type Agent = { id: string; name: string };

async function json<T = Json>(
  response: Awaited<ReturnType<APIRequestContext["get"]>>,
): Promise<T> {
  expect(
    response.ok(),
    `${response.url()} failed ${response.status()}: ${await response.text()}`,
  ).toBe(true);
  return (await response.json()) as T;
}

async function newCompany(request: APIRequestContext): Promise<Seed> {
  const company = await json<{ id: string; issuePrefix: string }>(
    await request.post("/api/companies", {
      data: { name: `Connection intent E2E ${Date.now()}` },
    }),
  );
  await json(
    await request.patch("/api/instance/settings/experimental", {
      data: { enableApps: true },
    }),
  );
  return { companyId: company.id, prefix: company.issuePrefix };
}

async function createAgent(
  request: APIRequestContext,
  companyId: string,
  name: string,
): Promise<Agent> {
  return await json<Agent>(
    await request.post(`/api/companies/${companyId}/agents`, {
      data: {
        name,
        role: "qa",
        title: "Connection intent fixture agent",
        capabilities: "Exercises deterministic connection intent wiring.",
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: ["--input-type=module", "-e", "process.exit(0)"],
        },
      },
    }),
  );
}

async function startFakeProvider() {
  const captures: Array<{ method: string; toolName: string | null }> = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const payload = JSON.parse(
      Buffer.concat(chunks).toString("utf8") || "{}",
    ) as {
      id?: string | number;
      method?: string;
      params?: { name?: string };
    };
    captures.push({
      method: String(payload.method ?? "<unknown>"),
      toolName: payload.params?.name ?? null,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    if (payload.method === "tools/list") {
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id ?? null,
          result: {
            tools: [
              {
                name: "notion:list_pages",
                title: "List fixture pages",
                description:
                  "Reads deterministic pages from the fake Notion provider.",
                inputSchema: {
                  type: "object",
                  properties: {},
                  additionalProperties: false,
                },
              },
            ],
          },
        }),
      );
      return;
    }
    if (payload.method === "tools/call") {
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id ?? null,
          result: {
            content: [{ type: "text", text: "Fixture page inventory" }],
          },
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({ jsonrpc: "2.0", id: payload.id ?? null, result: {} }),
    );
  });
  const port = await listenOnFetchAllowedPort(server);
  return {
    url: `http://127.0.0.1:${port}/`,
    captures,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function connectionAwareScript(connectionId: string) {
  return `
const post = async (url, body, token = process.env.PAPERCLIP_RUNTIME_TOOLS_TOKEN) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: \`Bearer \${token}\`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(\`\${response.status}: \${await response.text()}\`);
  return await response.json();
};
const search = await post(process.env.PAPERCLIP_RUNTIME_TOOLS_CONNECTIONS_SEARCH_URL, { query: "notion" });
const notion = search.results.find((result) => result.service === "notion");
if (!notion) throw new Error("Notion was not advertised");
if (notion.state !== "ready") {
  const requested = await post(process.env.PAPERCLIP_RUNTIME_TOOLS_CONNECTION_REQUEST_URL, { service: notion.service });
  if (requested.state !== "needs_user_action") throw new Error("Expected a user-action request");
  console.log("waiting for connection intent");
  process.exit(0);
}
const apiHeaders = { authorization: \`Bearer \${process.env.PAPERCLIP_API_KEY}\`, "content-type": "application/json" };
const sessionResponse = await fetch(\`\${process.env.PAPERCLIP_API_URL}/api/tool-gateway/sessions\`, {
  method: "POST",
  headers: apiHeaders,
  body: JSON.stringify({ runId: process.env.PAPERCLIP_RUN_ID, ttlMs: 60000 })
});
if (!sessionResponse.ok) throw new Error(await sessionResponse.text());
const session = await sessionResponse.json();
const toolsResponse = await fetch(\`\${process.env.PAPERCLIP_API_URL}/api/tool-gateway/tools\`, {
  headers: { "x-paperclip-tool-gateway-token": session.token }
});
const tools = await toolsResponse.json();
const tool = tools.find((entry) => entry.connectionId === ${JSON.stringify(connectionId)} && entry.upstreamToolName === "notion:list_pages");
if (!tool) throw new Error("Continuation did not receive the installed Notion tool");
const call = await fetch(\`\${process.env.PAPERCLIP_API_URL}/api/tool-gateway/tools/call\`, {
  method: "POST",
  headers: { "x-paperclip-tool-gateway-token": session.token, "content-type": "application/json" },
  body: JSON.stringify({ tool: tool.name, parameters: {} })
});
if (!call.ok) throw new Error(await call.text());
console.log(await call.text());
`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitForAgentRun(
  request: APIRequestContext,
  companyId: string,
  agentId: string,
) {
  let terminalRun: { id: string; status: string } | null = null;
  await expect
    .poll(
      async () => {
        const runs = await json<Array<{ id: string; status: string }>>(
          await request.get(
            `/api/companies/${companyId}/heartbeat-runs?agentId=${agentId}&limit=10`,
          ),
        );
        terminalRun =
          runs.find((run) => !["queued", "running"].includes(run.status)) ??
          null;
        return terminalRun?.status ?? null;
      },
      { timeout: 45_000 },
    )
    .toBe("succeeded");
  if (!terminalRun)
    throw new Error("Agent run completed without a run receipt");
  return terminalRun;
}

test("store setup and task connection intent share one fake provider through continuation", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const provider = await startFakeProvider();
  try {
    const seed = await newCompany(request);
    const holder = await createAgent(
      request,
      seed.companyId,
      "Existing access holder",
    );

    // Entry point one: connect and test the provider through the Connections store.
    await page.goto(`/${seed.prefix}/apps`);
    await expect(page.getByRole("heading", { name: "Connectors" })).toBeVisible({
      timeout: 30_000,
    });
    const customConnector = page
      .getByRole("list", { name: "Connector list" })
      .getByRole("listitem")
      .filter({ hasText: "Connect your own tool" });
    await customConnector.getByRole("button", { name: "Connect", exact: true }).click();
    await customConnector.getByRole("button", { name: "Connect your own MCP server" }).click();
    await page
      .getByPlaceholder("https://example.com/actions")
      .fill(provider.url);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: /Check link/i }).click();
    // A no-auth read-only provider can complete the access/install defaults in
    // one commit. Other methods exercise the same intermediate steps in the
    // shared-flow component suite.
    await expect(page.getByRole("heading", { name: /is ready/i })).toBeVisible({
      timeout: 30_000,
    });

    const connections = await json<{
      connections: Array<{ id: string; name: string; config: Json }>;
    }>(await request.get(`/api/companies/${seed.companyId}/tools/connections`));
    expect(connections.connections).toHaveLength(1);
    const connection = connections.connections[0]!;
    const connectionId = connection.id;
    await json(
      await request.patch(`/api/tool-connections/${connectionId}`, {
        data: {
          config: {
            ...connection.config,
            url: provider.url,
            sourceTemplateKey: "notion",
          },
        },
      }),
    );
    await json(
      await request.put(`/api/tool-connections/${connectionId}/installs`, {
        data: {
          installs: [{ targetType: "agent", targetId: holder.id }],
        },
      }),
    );

    await page.goto(`/${seed.prefix}/apps/${connectionId}/test`);
    await expect(
      page.getByRole("heading", { name: "Test an action" }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /List fixture pages/i }).click();
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.getByText("Fixture page inventory")).toBeVisible({
      timeout: 30_000,
    });

    // Entry point two: a scripted agent requests Notion, then the same shared
    // provider is reused from the task dialog and appears in the fresh run.
    const scout = await createAgent(
      request,
      seed.companyId,
      "Connection requester",
    );
    await json(
      await request.patch(`/api/agents/${scout.id}`, {
        data: {
          adapterType: "process",
          adapterConfig: {
            command: process.execPath,
            args: [
              "--input-type=module",
              "-e",
              connectionAwareScript(connectionId),
            ],
          },
          replaceAdapterConfig: true,
        },
      }),
    );
    const issue = await json<{ id: string; identifier: string }>(
      await request.post(`/api/companies/${seed.companyId}/issues`, {
        data: {
          title: "Read our Notion pages",
          status: "in_progress",
          assigneeAgentId: scout.id,
        },
      }),
    );
    // Assigning an in-progress task is the production wake path. Waiting for
    // that run avoids creating a second artificial request from an explicit
    // heartbeat invocation.
    const firstRun = await waitForAgentRun(request, seed.companyId, scout.id);

    const taskUrl = `/${seed.prefix}/issues/${issue.identifier}`;
    await page.goto(taskUrl);
    await expect(
      page.getByText("Connection requester needs Notion"),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Connect / Use existing" }).click();
    await expect(
      page.getByRole("heading", { name: "Use an existing connection" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: new RegExp(escapeRegExp(connection.name)) })
      .click();

    await expect(page.getByText("Notion connected")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page).toHaveURL(new RegExp(`${taskUrl}$`));
    await expect(
      page
        .getByTestId("connection-intent-focus-target")
        .filter({ hasText: "Notion connected" }),
    ).toBeFocused();
    expect(await page.locator("body").innerText()).not.toMatch(
      /\/authorize\?|authorizationUrl/,
    );

    await expect
      .poll(
        async () => {
          const runs = await json<Array<{ id: string; status: string }>>(
            await request.get(
              `/api/companies/${seed.companyId}/heartbeat-runs?agentId=${scout.id}&limit=10`,
            ),
          );
          return runs.find((run) => run.id !== firstRun.id)?.status ?? null;
        },
        { timeout: 45_000 },
      )
      .toBe("succeeded");
    await expect
      .poll(() =>
        provider.captures.some(
          (capture) =>
            capture.method === "tools/call" &&
            capture.toolName === "notion:list_pages",
        ),
      )
      .toBe(true);

    const interactions = await json<Array<{ kind: string; status: string }>>(
      await request.get(`/api/issues/${issue.id}/interactions`),
    );
    const connectionIntents = interactions.filter(
      (interaction) => interaction.kind === "connection_intent",
    );
    expect(
      connectionIntents.filter(
        (interaction) => interaction.status === "accepted",
      ),
    ).toHaveLength(1);
    expect(
      connectionIntents.filter(
        (interaction) => interaction.status === "pending",
      ),
    ).toHaveLength(0);
    expect(
      connectionIntents.every((interaction) =>
        ["accepted", "expired"].includes(interaction.status),
      ),
    ).toBe(true);
    expect(holder.id).not.toBe(scout.id);
  } finally {
    await provider.close();
  }
});
