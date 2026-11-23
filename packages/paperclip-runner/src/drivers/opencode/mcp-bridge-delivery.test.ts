import { createHash } from "node:crypto";
import { Agent, request } from "node:http";
import { afterEach, expect, it } from "vitest";
import { startOpenCodeMcpBridge, type OpenCodeMcpBridge } from "./mcp-bridge.js";
import { createOpenCodeFinishDiagnosticForwarder } from "../../cli/opencode-proxy-finish-diagnostics.js";

const bridges: OpenCodeMcpBridge[] = [];
const agents: Agent[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) agent.destroy();
  await Promise.all(bridges.splice(0).map(bridge => bridge.close()));
});

type Answer = { status: number; connection: string | undefined; reusedSocket: boolean; body: { id: unknown; result?: { content?: Array<{ text: string }> } } };

// A pooling client like Bun's fetch: it reuses an idle keep-alive socket
// whenever the server leaves one open.
function call(bridge: OpenCodeMcpBridge, agent: Agent, id: number, name: string): Promise<Answer> {
  const body = JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });
  return new Promise((resolve, reject) => {
    const outgoing = request(bridge.url, {
      method: "POST", agent,
      headers: { Authorization: `Bearer ${bridge.secret}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        connection: response.headers.connection,
        reusedSocket: outgoing.reusedSocket,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
      response.on("error", reject);
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

const tools = [
  { name: "list_agents", inputSchema: { type: "object" } },
  { name: "list_workflows", inputSchema: { type: "object" } },
  { name: "list_projects", inputSchema: { type: "object" } },
];

it("answers each tool call, including a parallel pair on a pooled keep-alive client, with its own delivery record", async () => {
  const messages: string[] = [];
  const bridge = await startOpenCodeMcpBridge({
    tools,
    handler: async ({ tool }) => {
      await new Promise(resolve => setTimeout(resolve, tool === "list_workflows" ? 40 : 10));
      return { tool };
    },
    onDiagnostic: message => { if (message.includes("tool-delivery-diagnostic")) messages.push(message); },
  });
  bridges.push(bridge);
  const agent = new Agent({ keepAlive: true, maxSockets: 8 });
  agents.push(agent);

  const first = await call(bridge, agent, 2, "list_agents");
  // Let the client finish handling the first response before the parallel
  // pair, as OpenCode does while the model writes its next step.
  await new Promise(resolve => setTimeout(resolve, 20));
  const [workflows, projects] = await Promise.all([
    call(bridge, agent, 3, "list_workflows"),
    call(bridge, agent, 4, "list_projects"),
  ]);

  for (const [answer, id, tool] of [[first, 2, "list_agents"], [workflows, 3, "list_workflows"], [projects, 4, "list_projects"]] as const) {
    expect(answer.status).toBe(200);
    expect(answer.body.id).toBe(id);
    expect(JSON.parse(answer.body.result!.content![0]!.text)).toEqual({ tool });
    // OpenCode's MCP client loses its tools when the bridge closes every
    // connection, so the bridge must keep the default keep-alive.
    expect(answer.connection).not.toBe("close");
  }

  await expect.poll(() => messages.length).toBe(3);
  const deliveries = messages.map(message => JSON.parse(message));
  expect(deliveries.map(delivery => delivery.callIdSha256).sort()).toEqual(
    ["2", "3", "4"].map(id => createHash("sha256").update(id).digest("hex")).sort(),
  );
  // The pooled client reuses a socket for at least one later call.
  expect(deliveries.some(delivery => delivery.socketRequestIndex > 1)).toBe(true);
  for (const delivery of deliveries) {
    expect(delivery).toEqual({
      schema: "paperclip.opencode.tool-delivery-diagnostic/v1",
      callIdSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      socketRequestIndex: expect.any(Number),
      socketIdleMs: delivery.socketRequestIndex === 1 ? null : expect.any(Number),
      handlerMs: expect.any(Number),
      argumentNames: [],
      argumentNamesTruncated: false,
      undeclaredArgumentCount: 0,
      outcome: "result",
      written: true,
    });
  }
  expect(JSON.stringify(messages)).not.toMatch(/list_|"tool"/);
});

it("records a call whose client left before its result was written", async () => {
  const messages: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const handlerStarted = new Promise<void>(resolve => { started = resolve; });
  const bridge = await startOpenCodeMcpBridge({
    tools,
    handler: async () => { started(); await held; return { ok: true }; },
    onDiagnostic: message => { if (message.includes("tool-delivery-diagnostic")) messages.push(message); },
  });
  bridges.push(bridge);
  const controller = new AbortController();
  const abandoned = fetch(bridge.url, {
    method: "POST", signal: controller.signal,
    headers: { Authorization: `Bearer ${bridge.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "list_agents", arguments: {} } }),
  }).catch(() => undefined);
  await handlerStarted;
  controller.abort();
  await abandoned;
  await expect.poll(() => messages.length).toBe(1);
  release();
  expect(JSON.parse(messages[0]!)).toMatchObject({ outcome: "unanswered", written: false, socketRequestIndex: 1 });
});

it("records a rejected call as an answered error", async () => {
  const messages: string[] = [];
  const bridge = await startOpenCodeMcpBridge({
    tools,
    handler: async () => ({ ok: true }),
    onDiagnostic: message => { if (message.includes("tool-delivery-diagnostic")) messages.push(message); },
  });
  bridges.push(bridge);
  const answer = await (await fetch(bridge.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${bridge.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "not_declared", arguments: {} } }),
  })).json() as { result: { isError: boolean } };
  expect(answer.result.isError).toBe(true);
  await expect.poll(() => messages.length).toBe(1);
  expect(JSON.parse(messages[0]!)).toMatchObject({
    callIdSha256: createHash("sha256").update("11").digest("hex"), outcome: "error", written: true,
  });
});

it("records the declared argument names a call delivered, never their values or undeclared names", async () => {
  const messages: string[] = [];
  const bridge = await startOpenCodeMcpBridge({
    tools: [{ name: "call_api", inputSchema: { type: "object", properties: {
      operationId: { type: "string" }, pathParams: { type: "object" }, query: { type: "object" }, body: {}, responseText: { type: "object" },
    } } }],
    handler: async () => ({ ok: false, status: 400 }),
    onDiagnostic: message => { if (message.includes("tool-delivery-diagnostic")) messages.push(message); },
  });
  bridges.push(bridge);
  await (await fetch(bridge.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${bridge.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "call_api", arguments: {
      operationId: "PATCH /api/issues/{id}", pathParams: { id: "secret-issue" }, query: {}, responseText: { limitBytes: 8192 }, PRIVATE_FIELD: 1,
    } } }),
  })).json();
  await expect.poll(() => messages.length).toBe(1);
  expect(JSON.parse(messages[0]!)).toMatchObject({ argumentNames: ["operationId", "pathParams", "query", "responseText"],
    argumentNamesTruncated: false, undeclaredArgumentCount: 1, outcome: "result" });
  expect(messages[0]).not.toMatch(/PATCH|secret-issue|8192|PRIVATE_FIELD/);
});

it("bounds many long argument names so the forwarder keeps the whole delivery record", async () => {
  const names = Array.from({ length: 32 }, (_, n) => `${String(n).padStart(2, "0")}${"a".repeat(62)}`);
  const messages: string[] = [];
  const bridge = await startOpenCodeMcpBridge({
    tools: [{ name: "wide_tool", inputSchema: { type: "object", properties: Object.fromEntries(names.map(name => [name, {}])) } }],
    handler: async () => ({ ok: true }),
    onDiagnostic: message => { if (message.includes("tool-delivery-diagnostic")) messages.push(message); },
  });
  bridges.push(bridge);
  await (await fetch(bridge.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${bridge.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "wide_tool",
      arguments: Object.fromEntries(names.map(name => [name, 1])) } }),
  })).json();
  await expect.poll(() => messages.length).toBe(1);
  const record = JSON.parse(messages[0]!);
  expect(record.argumentNamesTruncated).toBe(true);
  expect(record.argumentNames.length).toBeGreaterThan(0);
  expect(record.argumentNames.length).toBeLessThan(names.length);
  expect(record.argumentNames).toEqual(names.slice(0, record.argumentNames.length));
  expect(JSON.stringify(record.argumentNames).length).toBeLessThanOrEqual(1_024);
  expect(messages[0]!.length).toBeLessThanOrEqual(2_048);
  const frames: unknown[] = [];
  const forward = createOpenCodeFinishDiagnosticForwarder(frame => frames.push(frame));
  forward.bind("session");
  forward.diagnostic(messages[0]!);
  expect(frames).toHaveLength(1);
});
