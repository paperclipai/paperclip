import { readNativeSemanticReceipt, semanticInputSha256, type SemanticToolReceipt, type SemanticToolResult } from "./semantic-tool-receipt.js";
import { validatePrpStructuredRunResult } from "../protocol/replay-contract.js";
import { connect } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PRP_BLOCK_RESULT_PROVIDER_INPUT_SCHEMA,
  PRP_BLOCK_TOOL_DESCRIPTION,
  PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA,
  PRP_COMPLETION_TOOL_DESCRIPTION,
} from "../contracts/completion-result.js";

import {
  RUNNER_TOOL_SCOPE_TOKEN_HEADER,
  canonicalRunnerToolName,
  startRunnerToolBridge,
  type RunnerToolBridge,
  type RunnerToolCall,
} from "./runner-tool-bridge.js";

const bridges: RunnerToolBridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

type ToolCallBody = { result: { content: unknown } };

async function rpc(
  bridge: RunnerToolBridge,
  body: Record<string, unknown>,
  secret = bridge.secret,
): Promise<Response> {
  return fetch(bridge.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
  });
}

describe("runner semantic MCP bridge", () => {
  it.each([false, true])("preloads only essential public Claude task tools when opted in (%s)", async preloadClaudeTaskTools => {
    const bridge = await startRunnerToolBridge({
      preloadClaudeTaskTools,
      tools: [tool("paperclip__set_task_title"), {
        ...tool("documents.read"), _meta: { "anthropic/alwaysLoad": true },
      }],
      privateTools: [tool("__paperclip_permission")],
      handler: async () => ({ ok: true }),
    });
    bridges.push(bridge);
    const listed = await (await rpc(bridge, { id: 1, method: "tools/list" })).json() as {
      result: { tools: Array<{ name: string; _meta?: Record<string, unknown> }> };
    };
    expect(listed.result.tools.map(({ name }) => name)).toEqual([
      "set_task_title", "documents.read", "paperclip_finish", "paperclip_block",
    ]);
    expect(listed.result.tools.filter(tool => tool._meta?.["anthropic/alwaysLoad"] === true).map(({ name }) => name))
      .toEqual(preloadClaudeTaskTools ? ["set_task_title", "paperclip_finish", "paperclip_block"] : []);
    expect(listed.result.tools.find(tool => tool.name === "documents.read")?._meta).toBeUndefined();
  });

  it("binds to loopback, requires authentication, and exposes a closed catalog", async () => {
    const bridge = await startRunnerToolBridge({
      secret: "session-secret",
      tools: [tool("documents.read")],
      handler: async () => ({ ok: true }),
    });
    bridges.push(bridge);

    expect(new URL(bridge.url).hostname).toBe("127.0.0.1");
    expect(
      (await rpc(bridge, { id: 1, method: "tools/list" }, "wrong")).status,
    ).toBe(401);
    expect(
      await (await rpc(bridge, { id: 2, method: "tools/list" })).json(),
    ).toMatchObject({
      result: {
        tools: [
          { name: "documents.read" },
          { name: "paperclip_finish", description: PRP_COMPLETION_TOOL_DESCRIPTION, inputSchema: PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA },
          { name: "paperclip_block", description: PRP_BLOCK_TOOL_DESCRIPTION, inputSchema: PRP_BLOCK_RESULT_PROVIDER_INPUT_SCHEMA },
        ],
      },
    });
  });

  it("checks scoped credentials again after a delayed body before dispatch", async () => {
    let scope = "first", token = "first-scope-token", reads = 0;
    const handler = vi.fn(async () => ({ ok: true }));
    const bridge = await startRunnerToolBridge({ tools: [tool("documents.read")], handler,
      sessionScope: () => scope, scopeToken: () => { reads++; return token; } });
    bridges.push(bridge);
    const headers = (value: string) => ({ Authorization: `Bearer ${bridge.secret}`, "content-type": "application/json", [RUNNER_TOOL_SCOPE_TOKEN_HEADER]: `Bearer ${value}` });
    const initialize = (value: string) => fetch(bridge.url, { method: "POST", headers: headers(value), body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize" }) });
    expect((await rpc(bridge, { id: 0, method: "initialize" })).status).toBe(401);
    const first = await initialize(token); expect(first.status).toBe(200);
    const firstSession = first.headers.get("mcp-session-id")!;
    const previousReads = reads;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "documents.read", arguments: { path: "note" } } });
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const pending = fetch(bridge.url, { method: "POST", headers: { ...headers(token), "mcp-session-id": firstSession },
      body: new ReadableStream<Uint8Array>({ start(controller) { bodyController = controller; controller.enqueue(new TextEncoder().encode(body.slice(0, 20))); } }),
      duplex: "half" } as RequestInit);
    await vi.waitFor(() => expect(reads).toBeGreaterThan(previousReads));
    scope = "second"; token = "second-scope-token";
    const second = await initialize(token); expect(second.status).toBe(200);
    bodyController.enqueue(new TextEncoder().encode(body.slice(20))); bodyController.close();
    expect((await pending).status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    const accepted = await fetch(bridge.url, { method: "POST", headers: { ...headers(token), "mcp-session-id": second.headers.get("mcp-session-id")! }, body });
    expect(accepted.status).toBe(200); expect(handler).toHaveBeenCalledTimes(1);
  });

  it("keeps private operations callable but undiscoverable", async () => {
    const handler = vi.fn(async ({ tool: name }) => ({ name }));
    const bridge = await startRunnerToolBridge({
      tools: [tool("documents.read")],
      privateTools: [tool("__paperclip_permission")],
      handler,
    });
    bridges.push(bridge);
    const listed = (await (
      await rpc(bridge, { id: 1, method: "tools/list" })
    ).json()) as { result: { tools: Array<{ name: string }> } };
    expect(listed.result.tools.map(({ name }) => name)).not.toContain(
      "__paperclip_permission",
    );
    expect(
      await (
        await rpc(bridge, {
          id: "private-1",
          method: "tools/call",
          params: { name: "__paperclip_permission", arguments: {} },
        })
      ).json(),
    ).toMatchObject({
      result: {
        content: [{ text: expect.stringContaining("__paperclip_permission") }],
      },
    });
  });

  it("normalizes names and executes identical duplicate calls once", async () => {
    const handler = vi.fn(async () => ({ value: 7 }));
    const bridge = await startRunnerToolBridge({
      tools: [tool("documents.read")],
      handler,
    });
    bridges.push(bridge);
    const request = {
      id: "call-1",
      method: "tools/call",
      params: {
        name: "paperclip_documents.read",
        arguments: { id: "doc" },
      },
    };

    expect(await (await rpc(bridge, request)).json()).toMatchObject({
      result: { content: [{ text: '{"value":7}' }] },
    });
    expect(await (await rpc(bridge, request)).json()).toMatchObject({
      result: { content: [{ text: '{"value":7}' }] },
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "documents.read",
        callId: "call-1",
        arguments: { id: "doc" },
      }),
    );
  });

  it("rejects conflicting duplicate identities and validates before dispatch", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const bridge = await startRunnerToolBridge({
      tools: [
        {
          name: "documents.read",
          inputSchema: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" } },
            additionalProperties: false,
          },
        },
      ],
      handler,
    });
    bridges.push(bridge);

    expect(
      await (
        await rpc(bridge, {
          id: "same",
          method: "tools/call",
          params: { name: "documents.read", arguments: { id: 9 } },
        })
      ).json(),
    ).toMatchObject({ result: { isError: true } });
    expect(handler).not.toHaveBeenCalled();
    await rpc(bridge, {
      id: "same",
      method: "tools/call",
      params: { name: "documents.read", arguments: { id: "a" } },
    });
    expect(
      await (
        await rpc(bridge, {
          id: "same",
          method: "tools/call",
          params: { name: "documents.read", arguments: { id: "b" } },
        })
      ).json(),
    ).toMatchObject({
      result: {
        isError: true,
        content: [{ text: "Duplicate call identity conflict." }],
      },
    });
  });

  it("keeps numeric and string JSON-RPC identities distinct", async () => {
    const handler = vi.fn(async ({ callId }) => ({ callId }));
    const bridge = await startRunnerToolBridge({
      tools: [tool("documents.read")],
      handler,
    });
    bridges.push(bridge);

    await rpc(bridge, {
      id: 1,
      method: "tools/call",
      params: { name: "documents.read", arguments: { kind: "number" } },
    });
    await rpc(bridge, {
      id: "1",
      method: "tools/call",
      params: { name: "documents.read", arguments: { kind: "string" } },
    });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("times out calls", async () => {
    const bridge = await startRunnerToolBridge({
      tools: [tool("documents.read")],
      timeoutMs: 20,
      handler: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("handler aborted")),
            { once: true },
          );
        }),
    });
    bridges.push(bridge);

    expect(
      await (
        await rpc(bridge, {
          id: "slow",
          method: "tools/call",
          params: { name: "documents.read", arguments: {} },
        })
      ).json(),
    ).toMatchObject({
      result: {
        isError: true,
        content: [{ text: "Paperclip tool call timed out" }],
      },
    });
  });

  it.each([60_000, null])("honors MCP cancellation after the handler starts (timeout=%s)", async timeoutMs => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const aborted = vi.fn();
    const bridge = await startRunnerToolBridge({
      tools: [tool("documents.read")],
      timeoutMs,
      handler: ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted();
          reject(new Error("handler aborted"));
        }, { once: true });
        markStarted();
      }),
    });
    bridges.push(bridge);
    const pending = rpc(bridge, {
      id: "cancel-me",
      method: "tools/call",
      params: { name: "documents.read", arguments: {} },
    });
    // Observe request arrival without racing the separate timeout behavior.
    // Retain the rejection for the assertion while avoiding an unhandled fetch
    // rejection if a failed test closes the bridge before the request arrives.
    void pending.catch(() => undefined);
    await started;
    expect(
      (
        await rpc(bridge, {
          method: "notifications/cancelled",
          params: { requestId: "cancel-me" },
        })
      ).status,
    ).toBe(202);
    expect(await (await pending).json()).toMatchObject({
      result: {
        isError: true,
        content: [{ text: "Paperclip tool call cancelled" }],
      },
    });
    expect(aborted).toHaveBeenCalledOnce();
  });

  it("cancels a lease-owned native tool when its bridge closes", async () => {
    let admitted!: () => void;
    const started = new Promise<void>(resolve => { admitted = resolve; });
    let signal: AbortSignal | undefined;
    const bridge = await startRunnerToolBridge({ tools: [tool("documents.read")], timeoutMs: null,
      handler: call => { signal = call.signal; admitted(); return new Promise(() => {}); },
    });
    bridges.push(bridge);
    const pending = rpc(bridge, { id: "close-me", method: "tools/call", params: { name: "documents.read", arguments: {} } });
    await started;
    await bridge.close();
    expect(signal?.aborted).toBe(true);
    expect(await (await pending).json()).toMatchObject({ result: { isError: true,
      content: [{ text: "Paperclip tool call cancelled" }],
    } });
  });

  it("preserves successful mutation identity when the result is oversized", async () => {
    const result = { text: `snowman-${"☃".repeat(65 * 1024)}` };
    const handler = vi.fn(async () => result);
    const bridge = await startRunnerToolBridge({
      tools: [tool("documents.read")],
      handler,
    });
    bridges.push(bridge);
    const request = {
      id: "large-result",
      method: "tools/call",
      params: { name: "documents.read", arguments: {} },
    };

    const bodies = [];
    for (const response of [
      await rpc(bridge, request),
      await rpc(bridge, request),
    ]) {
      const body = (await response.json()) as {
        result: { content: Array<{ text: string }>; isError?: boolean };
      };
      expect(body.result).not.toHaveProperty("isError");
      const manifest = JSON.parse(body.result.content[0]!.text) as {
        schema: string;
        encoding: string;
        chunkCount: number;
        byteLength: number;
        sha256: string;
      };
      const serialized = body.result.content
        .slice(1)
        .map(({ text }) => text)
        .join("");
      expect(manifest).toMatchObject({
        schema: "paperclip.semantic_tool_result_chunks.v1",
        encoding: "json",
        chunkCount: body.result.content.length - 1,
        byteLength: Buffer.byteLength(serialized),
      });
      expect(
        body.result.content
          .slice(1)
          .every(({ text }) => Buffer.byteLength(text) <= 64 * 1024),
      ).toBe(true);
      expect(JSON.parse(serialized)).toEqual(result);
      bodies.push(body);
    }
    expect(bodies[1]).toEqual(bodies[0]);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("returns a complete tagged receipt for cyclic results without re-executing", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    cyclic.revision = 9_007_199_254_740_993n;
    const handler = vi.fn(async () => cyclic);
    const bridge = await startRunnerToolBridge({
      tools: [tool("documents.read")],
      handler,
    });
    bridges.push(bridge);

    const request = {
      id: "cyclic-result",
      method: "tools/call",
      params: { name: "documents.read", arguments: {} },
    };
    const first = (await (await rpc(bridge, request)).json()) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    const second = (await (await rpc(bridge, request)).json()) as typeof first;
    expect(first.result).not.toHaveProperty("isError");
    expect(JSON.parse(first.result.content[0]!.text)).toMatchObject({
      schema: "paperclip.semantic_tool_result.v1",
      status: "completed",
      tool: "documents.read",
      callIdentitySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      encoding: "paperclip.tagged_graph.v1",
      result: {
        root: { $ref: 1 },
        nodes: [
          {
            id: 1,
            type: "Object",
            properties: [
              { key: "self", value: { $ref: 1 } },
              {
                key: "revision",
                value: { $type: "bigint", value: "9007199254740993" },
              },
            ],
          },
        ],
      },
    });
    expect(second).toEqual(first);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("destroys oversized and stalled request bodies before dispatch", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const bridge = await startRunnerToolBridge({
      tools: [tool("documents.read")],
      handler,
      maxBodyBytes: 64,
      requestBodyTimeoutMs: 20,
    });
    bridges.push(bridge);

    await expect(
      rpc(bridge, {
        id: "oversized",
        method: "tools/call",
        params: {
          name: "documents.read",
          arguments: { value: "x".repeat(128) },
        },
      }),
    ).rejects.toThrow();

    const endpoint = new URL(bridge.url);
    const socket = connect({
      host: endpoint.hostname,
      port: Number(endpoint.port),
    });
    const closed = new Promise<void>((resolve) =>
      socket.once("close", () => resolve()),
    );
    socket.write(
      [
        "POST /mcp HTTP/1.1",
        `Host: ${endpoint.host}`,
        `Authorization: Bearer ${bridge.secret}`,
        "Content-Type: application/json",
        "Transfer-Encoding: chunked",
        "",
        "5",
        "{",
      ].join("\r\n"),
    );
    await expect(closed).resolves.toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });

  it("prevents catalog ambiguity and reserved schema replacement", async () => {
    await expect(
      startRunnerToolBridge({
        tools: [tool("documents.read"), tool("paperclip_documents.read")],
        handler: async () => null,
      }),
    ).rejects.toThrow("duplicated");
    await expect(
      startRunnerToolBridge({
        tools: [tool("paperclip_finish")],
        handler: async () => null,
      }),
    ).rejects.toThrow("reserved by the protocol");
    await expect(
      startRunnerToolBridge({
        tools: [tool("documents.read")],
        privateTools: [tool("documents.read")],
        handler: async () => null,
      }),
    ).rejects.toThrow("both public and private");
  });

  it("rejects unsupported HTTP shapes and closes idempotently", async () => {
    const bridge = await startRunnerToolBridge({
      tools: [],
      handler: async () => null,
    });
    bridges.push(bridge);
    expect(
      (
        await fetch(bridge.url, {
          method: "POST",
          headers: { Authorization: `Bearer ${bridge.secret}` },
          body: "{}",
        })
      ).status,
    ).toBe(415);
    await bridge.close();
    await bridge.close();
    bridges.splice(bridges.indexOf(bridge), 1);
  });

  it("normalizes every supported provider prefix", () => {
    expect(canonicalRunnerToolName("paperclip_documents.read")).toBe(
      "documents.read",
    );
    expect(canonicalRunnerToolName("paperclip__documents.read")).toBe(
      "documents.read",
    );
    expect(canonicalRunnerToolName("paperclip.documents.read")).toBe(
      "documents.read",
    );
  });
});

function tool(name: string): Readonly<Record<string, unknown>> {
  return { name, inputSchema: { type: "object" } };
}

describe("provider tool-use identity", () => {
  const META_KEY = "claudecode/toolUseId";
  const call = (id: string | number, args: Record<string, unknown>, meta?: Record<string, unknown>) => ({
    id, method: "tools/call", params: { name: "documents.read", arguments: args, ...(meta === undefined ? {} : { _meta: meta }) },
  });

  it("carries the provider tool-use id to the handler only when the caller names its meta key", async () => {
    const handler = vi.fn(async (_call: RunnerToolCall) => ({ ok: true }));
    const opted = await startRunnerToolBridge({ tools: [tool("documents.read")], providerToolUseIdMetaKey: META_KEY, handler });
    const plain = await startRunnerToolBridge({ tools: [tool("documents.read")], handler });
    bridges.push(opted, plain);
    await rpc(opted, call(2, { n: 1 }, { [META_KEY]: "toolu_01Abc", progressToken: 2 }));
    await rpc(plain, call(2, { n: 1 }, { [META_KEY]: "toolu_01Abc" }));
    expect(handler.mock.calls.map(([value]) => value.providerToolUseId))
      .toEqual(["toolu_01Abc", undefined]);
    expect(handler.mock.calls.map(([value]) => value.callId)).toEqual(["2", "2"]);
  });

  it("passes no id when the provider omits it and refuses a malformed one before dispatch", async () => {
    const handler = vi.fn(async (_call: RunnerToolCall) => ({ ok: true }));
    const bridge = await startRunnerToolBridge({ tools: [tool("documents.read")], providerToolUseIdMetaKey: META_KEY, handler });
    bridges.push(bridge);
    await rpc(bridge, call(1, { n: 1 }));
    await rpc(bridge, call(2, { n: 2 }, { progressToken: 2 }));
    expect(handler.mock.calls.map(([value]) => value.providerToolUseId))
      .toEqual([undefined, undefined]);
    for (const [index, value] of [7, "", "x".repeat(129), "toolu 01", "toolu_01\n", "_toolu", { id: "toolu_01" }].entries()) {
      expect(await (await rpc(bridge, call(10 + index, { n: 3 }, { [META_KEY]: value }))).json()).toMatchObject({
        result: { isError: true, content: [{ text: "Invalid provider tool-use identity." }] },
      });
    }
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("replays a retried tool use under a new request id and refuses it with different arguments", async () => {
    let finish!: (value: unknown) => void;
    const handler = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const bridge = await startRunnerToolBridge({ tools: [tool("documents.read")], providerToolUseIdMetaKey: META_KEY, handler });
    bridges.push(bridge);
    const first = rpc(bridge, call(2, { n: 1 }, { [META_KEY]: "toolu_A" }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    const retry = rpc(bridge, call(9, { n: 1 }, { [META_KEY]: "toolu_A" }));
    expect(await (await rpc(bridge, call(10, { n: 2 }, { [META_KEY]: "toolu_A" }))).json()).toMatchObject({
      result: { isError: true, content: [{ text: "Duplicate call identity conflict." }] },
    });
    finish({ value: 1 });
    expect(await (await first).json()).toMatchObject({ id: 2, result: { content: [{ text: '{"value":1}' }] } });
    expect(await (await retry).json()).toMatchObject({ id: 9, result: { content: [{ text: '{"value":1}' }] } });
    expect(await (await rpc(bridge, call(2, { n: 1 }, { [META_KEY]: "toolu_A" }))).json())
      .toMatchObject({ result: { content: [{ text: '{"value":1}' }] } });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("dispatches distinct tool uses that reuse a request id, as two turns' calls on one session do", async () => {
    const handler = vi.fn(async ({ providerToolUseId }: { providerToolUseId?: string }) => ({ providerToolUseId }));
    const bridge = await startRunnerToolBridge({ tools: [tool("documents.read")], providerToolUseIdMetaKey: META_KEY, handler });
    bridges.push(bridge);
    expect(await (await rpc(bridge, call(2, { n: 1 }, { [META_KEY]: "toolu_turn1" }))).json())
      .toMatchObject({ result: { content: [{ text: '{"providerToolUseId":"toolu_turn1"}' }] } });
    expect(await (await rpc(bridge, call(2, { n: 2 }, { [META_KEY]: "toolu_turn2" }))).json())
      .toMatchObject({ result: { content: [{ text: '{"providerToolUseId":"toolu_turn2"}' }] } });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("cancels a tool-use keyed call through its request id", async () => {
    let signal: AbortSignal | undefined;
    const handler = vi.fn((value: { signal: AbortSignal }) => { signal = value.signal; return new Promise(() => {}); });
    const bridge = await startRunnerToolBridge({ tools: [tool("documents.read")], providerToolUseIdMetaKey: META_KEY, handler });
    bridges.push(bridge);
    const pending = rpc(bridge, call(4, { n: 1 }, { [META_KEY]: "toolu_cancel" }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect((await rpc(bridge, { method: "notifications/cancelled", params: { requestId: 4 } })).status).toBe(202);
    expect(signal?.aborted).toBe(true);
    expect(await (await pending).json()).toMatchObject({ result: { isError: true, content: [{ text: "Paperclip tool call cancelled" }] } });
  });

  it("cancels only the call of the MCP session that sent the cancel when two sessions reuse a request id", async () => {
    const signals = new Map<string, AbortSignal>();
    const handler = vi.fn((value: { signal: AbortSignal; providerToolUseId?: string }) => {
      signals.set(value.providerToolUseId!, value.signal);
      return new Promise(() => {});
    });
    const bridge = await startRunnerToolBridge({ tools: [tool("documents.read")], providerToolUseIdMetaKey: META_KEY, handler });
    bridges.push(bridge);
    const send = (session: string, body: Record<string, unknown>) => fetch(bridge.url, { method: "POST",
      headers: { Authorization: `Bearer ${bridge.secret}`, "Content-Type": "application/json", "Mcp-Session-Id": session },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }) });
    const first = send("session-a", call(7, { n: 1 }, { [META_KEY]: "toolu_first" }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    const second = send("session-b", call(7, { n: 2 }, { [META_KEY]: "toolu_second" }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    expect((await send("session-a", { method: "notifications/cancelled", params: { requestId: 7 } })).status).toBe(202);
    expect(signals.get("toolu_first")?.aborted).toBe(true);
    expect(signals.get("toolu_second")?.aborted).toBe(false);
    expect(await (await first).json()).toMatchObject({ result: { isError: true, content: [{ text: "Paperclip tool call cancelled" }] } });
    expect((await send("session-b", { method: "notifications/cancelled", params: { requestId: 7 } })).status).toBe(202);
    expect(signals.get("toolu_second")?.aborted).toBe(true);
    await second;
  });
});

describe("Copilot semantic receipt opt-in", () => {
  const rawFinish = { reportedWorkDisposition: "done", summary: "The task is complete.", evidence: [], verification: [],
    completionClaim: { contractRevision: "1", objectiveSatisfied: true, criteria: [], remainingWork: [] } };
  it.each(["committed", "not-forwarded", "invalid", "duplicate-capture", "conflicting-capture", "duplicate-commit"])(
    "captures only the invocation's exact forwarded normalized input: %s", async mode => {
      const receipts: SemanticToolReceipt[] = [];
      let capturedInput: unknown;
      const bridge = await startRunnerToolBridge({ captureSemanticReceipt: () => receipt => receipts.push(receipt), handler: async call => {
        const validation = validatePrpStructuredRunResult(call.arguments);
        if (!validation.ok) throw new Error("Invalid fixture input");
        capturedInput = structuredClone(validation.result);
        const invalid: Record<string, unknown> = {}; invalid.self = invalid;
        const commit = call.captureNormalizedInput!(mode === "invalid" ? invalid : validation.result);
        if (mode === "duplicate-capture") call.captureNormalizedInput!(validation.result)();
        if (mode === "conflicting-capture") call.captureNormalizedInput!({ ...validation.result, summary: "foreign" })();
        if (mode !== "not-forwarded") commit();
        if (mode === "duplicate-commit") commit();
        // The digest is a snapshot of forwarded input, not a later mutable value.
        validation.result.summary = "later mutation";
        return { accepted: true };
      } });
      bridges.push(bridge);
      const request = { id: 3, method: "tools/call", params: { name: "paperclip_finish", arguments: rawFinish } };
      const body = await (await rpc(bridge, request)).json() as ToolCallBody;
      expect(receipts).toHaveLength(1);
      expect(readNativeSemanticReceipt({ contents: body.result.content })).toEqual(receipts[0]);
      expect(receipts[0]).toMatchObject({ schema: "paperclip.semantic_tool_receipt.v2", inputSha256: semanticInputSha256(rawFinish),
        normalizedInputSha256: mode === "committed" ? semanticInputSha256(capturedInput) : null });
      expect(semanticInputSha256(rawFinish)).not.toBe(semanticInputSha256(capturedInput));
      expect(await (await rpc(bridge, request)).json()).toEqual(body);
      expect(receipts).toHaveLength(1);
    },
  );
  it("keeps concurrent call captures separate and ignores captures after settlement", async () => {
    const pending = new Map<string, { capture: NonNullable<import("./runner-tool-bridge.js").RunnerToolCall["captureNormalizedInput"]>; settle: () => void }>();
    const receipts: SemanticToolReceipt[] = [];
    const bridge = await startRunnerToolBridge({ captureSemanticReceipt: () => receipt => receipts.push(receipt), handler: call => new Promise(resolve => {
      pending.set(call.callId, { capture: call.captureNormalizedInput!, settle: () => resolve({ accepted: true }) });
    }) });
    bridges.push(bridge);
    const first = rpc(bridge, { id: "first", method: "tools/call", params: { name: "paperclip_finish", arguments: rawFinish } });
    const secondInput = { ...rawFinish, summary: "Second call" };
    const second = rpc(bridge, { id: "second", method: "tools/call", params: { name: "paperclip_finish", arguments: secondInput } });
    await vi.waitFor(() => expect(pending.size).toBe(2));
    const normalizedFirst = validatePrpStructuredRunResult(rawFinish); const normalizedSecond = validatePrpStructuredRunResult(secondInput);
    if (!normalizedFirst.ok || !normalizedSecond.ok) throw new Error("Invalid fixture");
    pending.get("second")!.capture(normalizedSecond.result)(); pending.get("second")!.settle();
    const secondReceipt = readNativeSemanticReceipt({ contents: (await (await second).json() as ToolCallBody).result.content });
    expect(secondReceipt).toMatchObject({ inputSha256: semanticInputSha256(secondInput), normalizedInputSha256: semanticInputSha256(normalizedSecond.result) });
    pending.get("second")!.capture(normalizedFirst.result)();
    pending.get("first")!.capture(normalizedFirst.result)(); pending.get("first")!.settle();
    const firstReceipt = readNativeSemanticReceipt({ contents: (await (await first).json() as ToolCallBody).result.content });
    expect(firstReceipt).toMatchObject({ inputSha256: semanticInputSha256(rawFinish), normalizedInputSha256: semanticInputSha256(normalizedFirst.result) });
    expect(receipts).toEqual([secondReceipt, firstReceipt]);
  });
  it("does not accept model metadata as normalized authority or widen non-Copilot calls", async () => {
    const modelMetadata = { normalizedInputSha256: "a".repeat(64), captureNormalizedInput: "forged" };
    const withEvidence = await startRunnerToolBridge({ tools: [tool("documents.read")], captureSemanticReceipt: () => () => {}, handler: async call => {
      expect(call.captureNormalizedInput).toBeUndefined(); return modelMetadata;
    } }); bridges.push(withEvidence);
    const body = await (await rpc(withEvidence, { id: 1, method: "tools/call", params: { name: "documents.read", arguments: modelMetadata } })).json() as ToolCallBody;
    expect(readNativeSemanticReceipt({ contents: body.result.content })).toHaveProperty("normalizedInputSha256", null);
    const plain = await startRunnerToolBridge({ handler: async call => { expect(call.captureNormalizedInput).toBeUndefined(); return { accepted: true }; } }); bridges.push(plain);
    const plainBody = await (await rpc(plain, { id: 2, method: "tools/call", params: { name: "paperclip_finish", arguments: rawFinish } })).json() as ToolCallBody;
    expect(readNativeSemanticReceipt({ contents: plainBody.result.content })).toBeNull();
  });
  it.each(["small", "chunked", "tagged", "error"])("preserves %s result encoding and captures scope before dispatch", async encoding => {
    const receipts: SemanticToolReceipt[] = [];
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    const capture = vi.fn(() => (receipt: SemanticToolReceipt) => receipts.push(receipt));
    const handler = vi.fn(() => pending);
    const bridge = await startRunnerToolBridge({ tools: [tool("documents.read")], handler, captureSemanticReceipt: capture });
    bridges.push(bridge);
    const request = { id: 3, method: "tools/call", params: { name: "documents.read", arguments: {} } };
    const response = rpc(bridge, request);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(capture).toHaveBeenCalledTimes(1);
    if (encoding === "error") reject(new Error("bounded failure"));
    else resolve(encoding === "chunked" ? "x".repeat(70000) : encoding === "tagged" ? { bigint: 1n } : { accepted: false });
    const body = await (await response).json() as { result: SemanticToolResult };
    expect(receipts).toHaveLength(1);
    expect(readNativeSemanticReceipt({ contents: body.result.content })).toEqual(receipts[0]);
    expect(body.result.isError === true).toBe(encoding === "error");
    if (encoding === "small") expect(JSON.parse(body.result.content[0].text)).toEqual({ accepted: false });
    if (encoding === "error") expect(body.result.content[0].text).toBe("bounded failure");
    if (encoding === "chunked") expect(body.result.content.length).toBeGreaterThan(2);
    const replay = await (await rpc(bridge, request)).json();
    expect(replay).toEqual(body);
    expect(receipts).toHaveLength(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it("does not receipt unauthorized/unadmitted calls or let diagnostic errors change results", async () => {
    const capture = vi.fn(() => () => { throw new Error("diagnostic only"); });
    const bridge = await startRunnerToolBridge({ tools: [tool("documents.read")], handler: async () => ({ ok: true }), captureSemanticReceipt: capture });
    bridges.push(bridge);
    await rpc(bridge, { id: 1, method: "tools/call", params: { name: "documents.read" } }, "wrong");
    await rpc(bridge, { id: 2, method: "tools/call", params: { name: "unknown" } });
    expect(capture).not.toHaveBeenCalled();
    const body = await (await rpc(bridge, { id: 3, method: "tools/call", params: { name: "documents.read" } })).json() as { result: SemanticToolResult };
    expect(JSON.parse(body.result.content[0].text)).toEqual({ ok: true });
    expect(readNativeSemanticReceipt({ contents: body.result.content })).not.toBeNull();
  });
});

// The schema owner supplies scope policy; the transport only returns its guidance.
it("returns missing-field guidance before dispatch and accepts an explicit retry", async () => {
  const guidance = "Use the requested task UUID. For the active task, use read_document with key only.";
  const handler = vi.fn(async () => ({ accepted: true }));
  const bridge = await startRunnerToolBridge({ tools: [{ name: "read_task_document", inputSchema: {
    type: "object", required: ["taskId", "key"], additionalProperties: false,
    properties: { taskId: { type: "string", description: guidance }, key: { type: "string" } },
  } }], handler });
  bridges.push(bridge);
  const request = { id: "scope-retry", method: "tools/call", params: { name: "read_task_document", arguments: { key: "sentry-case" } } };
  type ScopeResponse = { result: { isError?: boolean; content: Array<{ text: string }> } };
  const rejected = await (await rpc(bridge, request)).json() as ScopeResponse;
  expect(rejected).toMatchObject({ result: { isError: true } });
  expect(handler).not.toHaveBeenCalled();
  expect(rejected.result.content[0].text).toContain(guidance);
  const taskId = "00000000-0000-4000-8000-000000000005";
  const accepted = await (await rpc(bridge, { ...request, params: { ...request.params, arguments: { key: "sentry-case", taskId } } })).json() as ScopeResponse;
  expect(accepted.result.isError).not.toBe(true);
  expect(handler).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ arguments: { key: "sentry-case", taskId } }));
});

describe("runner bridge repeated identical input rejections", () => {
  it("corrects the second identical rejection and stops the third", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const bridge = await startRunnerToolBridge({
      tools: [{ name: "update_case", inputSchema: { type: "object", additionalProperties: false, required: ["idempotencyKey"], properties: { idempotencyKey: { type: "string" }, title: { type: "string" } } } }],
      handler,
    });
    bridges.push(bridge);
    const text = async (id: number) => ((await (await rpc(bridge, { id, method: "tools/call", params: { name: "update_case", arguments: {} } })).json()) as {
      result: { content: Array<{ text: string }> };
    }).result.content[0]!.text;
    expect(await text(1)).not.toContain("rejected");
    expect(await text(2)).toContain("Expected properties: required idempotencyKey; optional title.");
    expect(await text(3)).toMatch(/^This call was not accepted: update_case was already rejected 2 times/);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("runner bridge input coercion", () => {
  it("accepts an object-typed field sent as JSON text, records it, and keeps text fields as text", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const diagnostics: string[] = [];
    const bridge = await startRunnerToolBridge({
      tools: [{ name: "update_case", inputSchema: { type: "object", additionalProperties: false, required: ["title", "patch"], properties: {
        title: { type: "string" }, patch: { type: ["object", "null"], required: ["status"], properties: { status: { type: "string" } } },
      } } }],
      handler,
      onDiagnostic: message => diagnostics.push(message),
    });
    bridges.push(bridge);
    const send = async (id: number, args: unknown) => ((await (await rpc(bridge, { id, method: "tools/call", params: { name: "update_case", arguments: args } })).json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    }).result;
    expect((await send(1, { title: '{"a":1}', patch: '{"status":"done"}' })).isError).not.toBe(true);
    expect(handler).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ arguments: { title: '{"a":1}', patch: { status: "done" } } }));
    expect(diagnostics.map(message => JSON.parse(message))).toEqual([
      expect.objectContaining({ schema: "paperclip.runner.tool-input-coerced/v1", tool: "update_case", paths: ["/patch"] }),
    ]);
    expect((await send(2, { title: "t", patch: "done" })).isError).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("runner bridge receipts for coerced input", () => {
  it("binds the receipt to the arguments as the host sent them, while the handler gets the parsed object", async () => {
    const receipts: SemanticToolReceipt[] = [];
    const handler = vi.fn(async () => ({ accepted: true }));
    const bridge = await startRunnerToolBridge({ captureSemanticReceipt: () => receipt => receipts.push(receipt), handler });
    bridges.push(bridge);
    const continuation = { kind: "response_wake", summary: "wait", idempotencyKey: "k" };
    const raw = { reportedWorkDisposition: "yielded", summary: "Waiting for the reply.", evidence: [], verification: [],
      completionClaim: { contractRevision: "1", objectiveSatisfied: false, criteria: [], remainingWork: [] }, continuation: JSON.stringify(continuation) };
    const body = await (await rpc(bridge, { id: 9, method: "tools/call", params: { name: "paperclip_finish", arguments: raw } })).json() as ToolCallBody;
    expect(handler).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ arguments: { ...raw, continuation } }));
    expect(receipts).toHaveLength(1);
    expect(readNativeSemanticReceipt({ contents: body.result.content })).toEqual(receipts[0]);
    expect(receipts[0]!.inputSha256).toBe(semanticInputSha256(raw));
  });
});
