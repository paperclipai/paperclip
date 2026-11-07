import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PRP_BLOCK_RESULT_PROVIDER_INPUT_SCHEMA,
  PRP_BLOCK_TOOL_DESCRIPTION,
  PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA,
  PRP_COMPLETION_TOOL_DESCRIPTION,
} from "../../contracts/completion-result.js";

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
  it("keeps a durable call pending across the ordinary timeout and replays its one result", async () => {
    let started!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    let complete!: (value: unknown) => void;
    const result = new Promise<unknown>(resolve => { complete = resolve; });
    const aborted = vi.fn();
    const handler = vi.fn(({ signal }) => {
      signal.addEventListener("abort", aborted, { once: true });
      started();
      return result;
    });
    const bridge = await startOpenCodeMcpBridge({
      tools: [{ name: "documents.write", inputSchema: { type: "object" } }],
      timeoutMs: null,
      handler,
    });
    bridges.push(bridge);
    const request = { id: "durable-write", method: "tools/call", params: { name: "documents.write", arguments: {} } };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = rpc(bridge, request).then(response => response.json());
    try {
      await begun;
      await vi.advanceTimersByTimeAsync(30_001);
      expect(aborted).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      complete({ receipt: "saved-once" });
    }
    const delivered = await pending;
    expect(delivered).toMatchObject({ result: { content: [{ text: '{"receipt":"saved-once"}' }] } });
    expect(await (await rpc(bridge, request)).json()).toEqual(delivered);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("cancels an unanswered durable call when the bridge closes without inventing a result", async () => {
    let started!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const aborted = vi.fn();
    const handler = vi.fn(({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted(); reject(new Error("unknown outcome")); }, { once: true });
      started();
    }));
    const bridge = await startOpenCodeMcpBridge({
      tools: [{ name: "documents.write", inputSchema: { type: "object" } }], timeoutMs: null, handler,
    });
    const pending = rpc(bridge, { id: "close-durable", method: "tools/call", params: { name: "documents.write", arguments: {} } });
    await begun;
    await bridge.close();
    expect(await (await pending).json()).toMatchObject({ result: { isError: true, content: [{ text: "Paperclip tool call cancelled" }] } });
    expect(aborted).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("abandons a call on disconnect only after every waiting connection is gone", async () => {
    let started!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const aborted = vi.fn();
    const handler = vi.fn(({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted(); reject(new Error("abandoned")); }, { once: true });
      started();
    }));
    const bridge = await startOpenCodeMcpBridge({
      tools: [{ name: "documents.write", inputSchema: { type: "object" } }], timeoutMs: null, handler,
    });
    bridges.push(bridge);
    const body = JSON.stringify({ jsonrpc: "2.0", id: "retried", method: "tools/call", params: { name: "documents.write", arguments: {} } });
    const post = (signal: AbortSignal) => fetch(bridge.url, {
      method: "POST", body, signal,
      headers: { Authorization: `Bearer ${bridge.secret}`, "Content-Type": "application/json" },
    });
    const first = new AbortController();
    const retry = new AbortController();
    const firstResponse = post(first.signal).catch(() => "dropped");
    await begun;
    const retryResponse = post(retry.signal).catch(() => "dropped");
    await new Promise(resolve => setTimeout(resolve, 50));
    first.abort();
    expect(await firstResponse).toBe("dropped");
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(aborted).not.toHaveBeenCalled();
    retry.abort();
    expect(await retryResponse).toBe("dropped");
    for (let attempt = 0; attempt < 100 && !aborted.mock.calls.length; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(aborted).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
  });

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
        { name: "paperclip_finish", description: PRP_COMPLETION_TOOL_DESCRIPTION, inputSchema: PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA },
        { name: "paperclip_block", description: PRP_BLOCK_TOOL_DESCRIPTION, inputSchema: PRP_BLOCK_RESULT_PROVIDER_INPUT_SCHEMA },
      ] },
    });
  });

  it("delivers a complete large assigned-tool result and replays its receipt without repeating the action", async () => {
    const files = Array.from({ length: 27 }, (_, index) => ({
      filename: `src/public-fixture-${index}.ts`,
      patch: `@@ synthetic public fixture ${index} @@\n${"+ documented change\n".repeat(220)}`,
    }));
    const data = { items: files, page: 1, hasMore: false, receipt: "LAST_FILE_AND_RECEIPT_INTACT" };
    const result = { content: [{ type: "text", text: JSON.stringify(data) }], data };
    expect(JSON.stringify(result).length).toBeGreaterThan(111_877);
    const handler = vi.fn(async () => result);
    const bridge = await startOpenCodeMcpBridge({
      tools: [{ name: "paperclip_call_assigned_tool", inputSchema: { type: "object" } }], handler,
    });
    bridges.push(bridge);
    const request = { id: "large-result", method: "tools/call", params: { name: "paperclip_call_assigned_tool", arguments: {} } };
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await (await rpc(bridge, request)).json() as { result: { content: Array<{ text: string }> } };
      expect(JSON.parse(response.result.content[0]!.text)).toEqual(result);
    }
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("preserves producer-sized pages with UTF-8 and heavily escaped nested data", async () => {
    const chunk = '\"\\\n\t\u0000😀';
    const result = { responseText: { nextOffsetBytes: 300_000, totalBytes: 600_000 }, data: chunk.repeat(25_000) };
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(500_000);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(64 * 1024);
    // The driver returns a controller text item, not the raw app page. Its
    // encoded JSON must survive a second layer of escaping at this boundary.
    const controllerResult = { text: JSON.stringify(result), type: "inputText" };
    expect(Buffer.byteLength(JSON.stringify(controllerResult))).toBeGreaterThan(500_000);
    const bridge = await startOpenCodeMcpBridge({
      tools: [{ name: "read_tool_result", inputSchema: { type: "object" } }], handler: async () => controllerResult,
    });
    bridges.push(bridge);
    const response = await (await rpc(bridge, { id: "page", method: "tools/call", params: { name: "read_tool_result", arguments: {} } })).json() as { result: { content: Array<{ text: string }> } };
    const delivered = JSON.parse(response.result.content[0]!.text) as typeof controllerResult;
    expect(delivered).toEqual(controllerResult);
    expect(JSON.parse(delivered.text)).toEqual(result);
  });

  it.each([
    ["UTF-8 scalar", () => ({ data: "😀".repeat(300_000) })],
    ["escaped scalar", () => ({ data: "\u0000".repeat(200_000) })],
    ["many fields", () => Array.from({ length: 600_000 }, () => 0)],
  ])("rejects an oversized %s without a partial success or repeating the completed call", async (_name, makeResult) => {
    const handler = vi.fn(async () => makeResult());
    const bridge = await startOpenCodeMcpBridge({
      tools: [{ name: "assigned.write", inputSchema: { type: "object" } }], handler,
    });
    bridges.push(bridge);
    const request = { id: "write-receipt", method: "tools/call", params: { name: "assigned.write", arguments: {} } };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await (await rpc(bridge, request)).json()).toMatchObject({
        result: { isError: true, content: [{ text: expect.stringContaining("may already have completed; do not repeat it") }] },
      });
    }
    expect(handler).toHaveBeenCalledTimes(1);
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

  it("preserves declared prefixed operation IDs through HTTP MCP and rejects undeclared aliases", async () => {
    const names = ["paperclip_search_assigned_tools", "paperclip_call_assigned_tool", "search_assigned_tools"];
    const handler = vi.fn(async call => ({ operation: call.tool }));
    const bridge = await startOpenCodeMcpBridge({ tools: names.map(name => ({ name, inputSchema: { type: "object" } })), handler });
    bridges.push(bridge);
    const listed = await (await rpc(bridge, { id: "list", method: "tools/list" })).json() as { result: { tools: Array<{ name: string }> } };
    expect(listed.result.tools.map(tool => tool.name)).toEqual([...names, "paperclip_finish", "paperclip_block"]);
    for (const [i, name] of names.entries()) {
      for (const [j, prefix] of ["", "paperclip_", "paperclip__", "paperclip."].entries()) {
        const called = prefix === "paperclip_" && name === "search_assigned_tools" ? name : prefix + name;
        const result = await (await rpc(bridge, { id: `call-${i}-${j}`, method: "tools/call", params: { name: called, arguments: {} } })).json();
        expect(result).toMatchObject({ result: { content: [{ text: JSON.stringify({ operation: name }) }] } });
      }
    }
    const before = handler.mock.calls.length;
    expect(await (await rpc(bridge, { id: "unknown", method: "tools/call", params: { name: "paperclip_unassigned_tool", arguments: {} } })).json()).toMatchObject({ result: { isError: true } });
    expect(handler).toHaveBeenCalledTimes(before);
  });

  it("does not authorize a shortened operation when only its prefixed name is declared", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const bridge = await startOpenCodeMcpBridge({ tools: [{ name: "paperclip_search_assigned_tools", inputSchema: { type: "object" } }], handler });
    bridges.push(bridge);
    expect(await (await rpc(bridge, { id: "short", method: "tools/call", params: { name: "search_assigned_tools", arguments: {} } })).json()).toMatchObject({ result: { isError: true } });
    expect(handler).not.toHaveBeenCalled();
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

  it.each([undefined, null])("honors MCP cancellation notifications (timeout=%s)", async timeoutMs => {
    const started = vi.fn();
    const bridge = await startOpenCodeMcpBridge({
      tools: [{ name: "documents.read", inputSchema: { type: "object" } }],
      timeoutMs,
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

it("reports admitted schema rejections without invoking handlers or widening authentication", async () => {
  const handler = vi.fn(async () => ({ accepted: true }));
  const rejected = vi.fn();
  const bridge = await startOpenCodeMcpBridge({
    tools: [{ name: "probe", inputSchema: { type: "object" } }], handler, onRejectedCall: rejected,
  });
  bridges.push(bridge);
  const body = { id: "bad", method: "tools/call", params: { name: "probe", arguments: [] } };
  expect((await rpc(bridge, body, "wrong")).status).toBe(401);
  await rpc(bridge, { ...body, params: { name: "unassigned", arguments: [] } });
  expect(rejected).not.toHaveBeenCalled();
  expect(await (await rpc(bridge, body)).json()).toMatchObject({ result: { isError: true } });
  expect(rejected).toHaveBeenCalledExactlyOnceWith({ tool: "probe", callId: "bad", arguments: [] }, expect.stringContaining("Invalid tool input"));
  expect(handler).not.toHaveBeenCalled();
});
it("keeps schema rejection intact when its observer fails", async () => {
  const handler = vi.fn(async () => ({}));
  const bridge = await startOpenCodeMcpBridge({ handler, onRejectedCall: () => { throw new Error("observer unavailable"); } });
  bridges.push(bridge);
  expect(await (await rpc(bridge, { id: 1, method: "tools/call", params: { name: "paperclip_finish", arguments: {} } })).json()).toMatchObject({ result: { isError: true } });
  expect(handler).not.toHaveBeenCalled();
});
it("reports conflicting request IDs without repeating the accepted action", async () => {
  const handler = vi.fn(async () => ({ accepted: true }));
  const rejected = vi.fn();
  const bridge = await startOpenCodeMcpBridge({ tools: [{ name: "probe", inputSchema: { type: "object" } }], handler, onRejectedCall: rejected });
  bridges.push(bridge);
  const body = { id: "same", method: "tools/call", params: { name: "probe", arguments: { name: "first" } } };
  await rpc(bridge, body);
  expect(await (await rpc(bridge, { ...body, params: { name: "probe", arguments: { name: "second" } } })).json()).toMatchObject({ result: { isError: true } });
  expect(handler).toHaveBeenCalledOnce();
  expect(rejected).toHaveBeenCalledExactlyOnceWith({ tool: "probe", callId: "same", arguments: { name: "second" } }, "Duplicate call identity conflict.");
});
