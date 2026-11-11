import { createHash } from "node:crypto";
import { Agent, request } from "node:http";
import { afterEach, expect, it } from "vitest";
import { startOpenCodeMcpBridge, type OpenCodeMcpBridge } from "./mcp-bridge.js";

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

it("answers every tool call on its own connection so a pooled socket can never strand a parallel result", async () => {
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
    expect(answer.connection).toBe("close");
    expect(answer.reusedSocket).toBe(false);
  }

  await expect.poll(() => messages.length).toBe(3);
  const deliveries = messages.map(message => JSON.parse(message));
  expect(deliveries.map(delivery => delivery.callIdSha256).sort()).toEqual(
    ["2", "3", "4"].map(id => createHash("sha256").update(id).digest("hex")).sort(),
  );
  for (const delivery of deliveries) {
    expect(delivery).toEqual({
      schema: "paperclip.opencode.tool-delivery-diagnostic/v1",
      callIdSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      socketRequestIndex: 1,
      socketIdleMs: null,
      handlerMs: expect.any(Number),
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
  const bridge = await startOpenCodeMcpBridge({
    tools,
    handler: async () => { await held; return { ok: true }; },
    onDiagnostic: message => { if (message.includes("tool-delivery-diagnostic")) messages.push(message); },
  });
  bridges.push(bridge);
  const controller = new AbortController();
  const abandoned = fetch(bridge.url, {
    method: "POST", signal: controller.signal,
    headers: { Authorization: `Bearer ${bridge.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "list_agents", arguments: {} } }),
  }).catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, 30));
  controller.abort();
  await abandoned;
  await expect.poll(() => messages.length).toBe(1);
  release();
  expect(JSON.parse(messages[0]!)).toMatchObject({ outcome: "unanswered", written: false, socketRequestIndex: 1 });
});
