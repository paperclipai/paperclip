import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalOpenCodeMcpToolName, startOpenCodeMcpBridge, type OpenCodeMcpBridge } from "./mcp-bridge.js";

const bridges: OpenCodeMcpBridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

async function rpc(
  bridge: OpenCodeMcpBridge,
  body: Record<string, unknown>,
  secret = bridge.secret,
) {
  return fetch(bridge.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
  });
}

describe("OpenCode MCP bridge", () => {
  it("binds to loopback, requires authentication, and exposes only its closed catalog", async () => {
    const bridge = await startOpenCodeMcpBridge({
      secret: "session-secret",
      tools: [{ name: "documents.read", description: "Read", inputSchema: { type: "object" } }],
      handler: async () => ({ ok: true }),
    });
    bridges.push(bridge);
    expect(new URL(bridge.url).hostname).toBe("127.0.0.1");
    expect((await rpc(bridge, { id: 1, method: "tools/list" }, "wrong")).status).toBe(401);
    const listed = await rpc(bridge, { id: 2, method: "tools/list" });
    expect(await listed.json()).toMatchObject({
      result: { tools: [
        { name: "documents.read" },
        { name: "paperclip_finish" },
        { name: "paperclip_block" },
      ] },
    });
  });

  it("admits runner-private extension operations without advertising them to the model", async () => {
    const handler = vi.fn(async ({ tool }) => ({ decision: tool === "__paperclip_permission" ? "accept" : "decline" }));
    const bridge = await startOpenCodeMcpBridge({
      tools: [{ name: "documents.read", inputSchema: { type: "object" } }],
      privateTools: [{ name: "__paperclip_permission", inputSchema: { type: "object" } }],
      handler,
    });
    bridges.push(bridge);
    const listed = await (await rpc(bridge, { id: 1, method: "tools/list" })).json() as { result: { tools: Array<{ name: string }> } };
    expect(listed.result.tools.map((tool) => tool.name)).not.toContain("__paperclip_permission");
    expect(await (await rpc(bridge, {
      id: "permission-1",
      method: "tools/call",
      params: { name: "__paperclip_permission", arguments: {} },
    })).json()).toMatchObject({ result: { content: [{ text: "{\"decision\":\"accept\"}" }] } });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ tool: "__paperclip_permission" }));
  });

  it("maps prefixed names and replays identical duplicate calls exactly once", async () => {
    const handler = vi.fn(async () => ({ value: 7 }));
    const bridge = await startOpenCodeMcpBridge({
      tools: [{ name: "documents.read", inputSchema: { type: "object" } }],
      handler,
    });
    bridges.push(bridge);
    const request = { id: "call-1", method: "tools/call", params: { name: "paperclip_documents.read", arguments: { id: "doc" } } };
    expect(await (await rpc(bridge, request)).json()).toMatchObject({ result: { content: [{ text: "{\"value\":7}" }] } });
    expect(await (await rpc(bridge, request)).json()).toMatchObject({ result: { content: [{ text: "{\"value\":7}" }] } });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ tool: "documents.read", callId: "call-1", arguments: { id: "doc" } }));
  });

  it("fails conflicting duplicate identities and handler errors closed", async () => {
    const bridge = await startOpenCodeMcpBridge({
      tools: [{ name: "documents.read", inputSchema: { type: "object" } }],
      handler: async () => { throw new Error("denied"); },
    });
    bridges.push(bridge);
    const failed = await rpc(bridge, { id: "call-2", method: "tools/call", params: { name: "documents.read", arguments: { id: "a" } } });
    expect(await failed.json()).toMatchObject({ result: { isError: true, content: [{ text: "denied" }] } });
    const conflict = await rpc(bridge, { id: "call-2", method: "tools/call", params: { name: "documents.read", arguments: { id: "b" } } });
    expect(await conflict.json()).toMatchObject({ result: { isError: true, content: [{ text: "Duplicate call identity conflict." }] } });
  });

  it("normalizes all supported OpenCode MCP prefixes", () => {
    expect(canonicalOpenCodeMcpToolName("paperclip_documents.read")).toBe("documents.read");
    expect(canonicalOpenCodeMcpToolName("paperclip__documents.read")).toBe("documents.read");
    expect(canonicalOpenCodeMcpToolName("paperclip.documents.read")).toBe("documents.read");
    expect(canonicalOpenCodeMcpToolName("paperclip_paperclip_finish")).toBe("paperclip_finish");
  });

  it("validates inputs before dispatch", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const bridge = await startOpenCodeMcpBridge({
      tools: [{
        name: "documents.read",
        inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false },
      }],
      handler,
    });
    bridges.push(bridge);
    const response = await rpc(bridge, {
      id: "invalid",
      method: "tools/call",
      params: { name: "documents.read", arguments: { id: 9 } },
    });
    expect(await response.json()).toMatchObject({ result: { isError: true } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("times out and cancels in-flight calls", async () => {
    const observed = vi.fn();
    const bridge = await startOpenCodeMcpBridge({
      tools: [{ name: "documents.read", inputSchema: { type: "object" } }],
      timeoutMs: 20,
      handler: ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => { observed(); reject(new Error("aborted")); }, { once: true });
      }),
    });
    bridges.push(bridge);
    const response = await rpc(bridge, {
      id: "slow-call",
      method: "tools/call",
      params: { name: "documents.read", arguments: {} },
    });
    expect(await response.json()).toMatchObject({ result: { isError: true, content: [{ text: "Paperclip tool call timed out" }] } });
    expect(observed).toHaveBeenCalledOnce();
  });

  it("allows human-gated private calls to outlive ordinary tool timeouts", async () => {
    const bridge = await startOpenCodeMcpBridge({
      tools: [{ name: "documents.read", inputSchema: { type: "object" } }],
      privateTools: [{ name: "__paperclip_runtime_input", inputSchema: { type: "object" } }],
      timeoutMs: 20,
      privateToolTimeoutMs: 200,
      handler: async ({ tool }) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { tool, resolved: true };
      },
    });
    bridges.push(bridge);
    const response = await rpc(bridge, {
      id: "human-input",
      method: "tools/call",
      params: { name: "__paperclip_runtime_input", arguments: {} },
    });
    expect(await response.json()).toMatchObject({
      result: { content: [{ text: expect.stringContaining("\"resolved\":true") }] },
    });
  });

  it("honors MCP cancellation notifications", async () => {
    const started = vi.fn();
    const bridge = await startOpenCodeMcpBridge({
      tools: [{ name: "documents.read", inputSchema: { type: "object" } }],
      handler: ({ signal }) => new Promise((_resolve, reject) => {
        started();
        signal.addEventListener("abort", () => reject(new Error("handler aborted")), { once: true });
      }),
    });
    bridges.push(bridge);
    const pending = rpc(bridge, {
      id: "cancel-me",
      method: "tools/call",
      params: { name: "documents.read", arguments: {} },
    });
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    expect((await rpc(bridge, {
      method: "notifications/cancelled",
      params: { requestId: "cancel-me", reason: "turn stopped" },
    })).status).toBe(202);
    expect(await (await pending).json()).toMatchObject({
      result: { isError: true, content: [{ text: "Paperclip tool call cancelled" }] },
    });
  });
});
