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

  it("times out calls and honors MCP cancellation", async () => {
    const starts: string[] = [];
    const bridge = await startRunnerToolBridge({
      tools: [tool("documents.read")],
      timeoutMs: 20,
      handler: ({ callId, signal }) =>
        new Promise((_resolve, reject) => {
          starts.push(callId);
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
    const pending = rpc(bridge, {
      id: "cancel-me",
      method: "tools/call",
      params: { name: "documents.read", arguments: {} },
    });
    await vi.waitFor(() => expect(starts).toContain("cancel-me"), {
      interval: 1,
      timeout: 15,
    });
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
