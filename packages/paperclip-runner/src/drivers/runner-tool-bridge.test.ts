import { readNativeSemanticReceipt, semanticInputSha256, type SemanticToolReceipt, type SemanticToolResult } from "./semantic-tool-receipt.js";
import { validatePrpStructuredRunResult } from "../protocol/replay-contract.js";
import { connect } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canonicalRunnerToolName,
  startRunnerToolBridge,
  type RunnerToolBridge,
} from "./runner-tool-bridge.js";

const bridges: RunnerToolBridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

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
          { name: "paperclip_finish" },
          { name: "paperclip_block" },
        ],
      },
    });
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

  it("honors MCP cancellation after the handler starts", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const aborted = vi.fn();
    const bridge = await startRunnerToolBridge({
      tools: [tool("documents.read")],
      timeoutMs: 60_000,
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
      const body = await (await rpc(bridge, request)).json();
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
    const secondReceipt = readNativeSemanticReceipt({ contents: (await (await second).json()).result.content });
    expect(secondReceipt).toMatchObject({ inputSha256: semanticInputSha256(secondInput), normalizedInputSha256: semanticInputSha256(normalizedSecond.result) });
    pending.get("second")!.capture(normalizedFirst.result)();
    pending.get("first")!.capture(normalizedFirst.result)(); pending.get("first")!.settle();
    const firstReceipt = readNativeSemanticReceipt({ contents: (await (await first).json()).result.content });
    expect(firstReceipt).toMatchObject({ inputSha256: semanticInputSha256(rawFinish), normalizedInputSha256: semanticInputSha256(normalizedFirst.result) });
    expect(receipts).toEqual([secondReceipt, firstReceipt]);
  });
  it("does not accept model metadata as normalized authority or widen non-Copilot calls", async () => {
    const modelMetadata = { normalizedInputSha256: "a".repeat(64), captureNormalizedInput: "forged" };
    const withEvidence = await startRunnerToolBridge({ tools: [tool("documents.read")], captureSemanticReceipt: () => () => {}, handler: async call => {
      expect(call.captureNormalizedInput).toBeUndefined(); return modelMetadata;
    } }); bridges.push(withEvidence);
    const body = await (await rpc(withEvidence, { id: 1, method: "tools/call", params: { name: "documents.read", arguments: modelMetadata } })).json();
    expect(readNativeSemanticReceipt({ contents: body.result.content })).toHaveProperty("normalizedInputSha256", null);
    const plain = await startRunnerToolBridge({ handler: async call => { expect(call.captureNormalizedInput).toBeUndefined(); return { accepted: true }; } }); bridges.push(plain);
    const plainBody = await (await rpc(plain, { id: 2, method: "tools/call", params: { name: "paperclip_finish", arguments: rawFinish } })).json();
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
