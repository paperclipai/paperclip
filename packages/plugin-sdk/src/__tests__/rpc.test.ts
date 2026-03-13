import { describe, it, expect } from "vitest";
import { parseJsonRpcMessage, serializeJsonRpcRequest, serializeJsonRpcResponse, RpcChannel } from "../rpc.js";
import { PassThrough } from "node:stream";

describe("parseJsonRpcMessage", () => {
  it("parses a valid request", () => {
    const msg = '{"jsonrpc":"2.0","id":1,"method":"health","params":{}}';
    const parsed = parseJsonRpcMessage(msg);
    expect(parsed).toEqual({ jsonrpc: "2.0", id: 1, method: "health", params: {} });
  });

  it("parses a valid response", () => {
    const msg = '{"jsonrpc":"2.0","id":1,"result":{"status":"ok"}}';
    const parsed = parseJsonRpcMessage(msg);
    expect(parsed).toEqual({ jsonrpc: "2.0", id: 1, result: { status: "ok" } });
  });

  it("throws on invalid JSON", () => {
    expect(() => parseJsonRpcMessage("not json")).toThrow();
  });

  it("throws on missing jsonrpc field", () => {
    expect(() => parseJsonRpcMessage('{"id":1,"method":"foo"}')).toThrow("not a valid JSON-RPC");
  });
});

describe("serializeJsonRpcRequest", () => {
  it("serializes a request with newline delimiter", () => {
    const result = serializeJsonRpcRequest(1, "health", {});
    expect(result).toBe('{"jsonrpc":"2.0","id":1,"method":"health","params":{}}\n');
  });

  it("serializes a request without params", () => {
    const result = serializeJsonRpcRequest(2, "shutdown");
    expect(result).toBe('{"jsonrpc":"2.0","id":2,"method":"shutdown"}\n');
  });
});

describe("serializeJsonRpcResponse", () => {
  it("serializes a success response", () => {
    const result = serializeJsonRpcResponse(1, { ok: true });
    expect(result).toBe('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
  });

  it("serializes an error response", () => {
    const result = serializeJsonRpcResponse(1, undefined, { code: -32600, message: "denied" });
    expect(result).toBe('{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"denied"}}\n');
  });
});

describe("RpcChannel", () => {
  function createPair() {
    const aToB = new PassThrough();
    const bToA = new PassThrough();
    const channelA = new RpcChannel(bToA, aToB);
    const channelB = new RpcChannel(aToB, bToA);
    return { channelA, channelB };
  }

  it("sends request and receives response", async () => {
    const { channelA, channelB } = createPair();
    channelB.setRequestHandler(async (method) => {
      if (method === "health") return { status: "ok" };
      throw new Error("unknown method");
    });
    const result = await channelA.call("health");
    expect(result).toEqual({ status: "ok" });
    channelA.destroy();
    channelB.destroy();
  });

  it("handles bidirectional concurrent calls", async () => {
    const { channelA, channelB } = createPair();
    channelA.setRequestHandler(async (method, params) => {
      if (method === "issues.create") return { id: "iss-1", ...(params as object) };
      throw new Error("unknown");
    });
    channelB.setRequestHandler(async (method) => {
      if (method === "runJob") return { ok: true };
      throw new Error("unknown");
    });

    const [jobResult, issueResult] = await Promise.all([
      channelA.call("runJob", { jobKey: "sync" }),
      channelB.call("issues.create", { title: "Test" }),
    ]);
    expect(jobResult).toEqual({ ok: true });
    expect(issueResult).toEqual({ id: "iss-1", title: "Test" });
    channelA.destroy();
    channelB.destroy();
  });

  it("rejects on timeout", async () => {
    const { channelA, channelB } = createPair();
    // No handler set on B — request will never be answered
    await expect(channelA.call("health", {}, 50)).rejects.toThrow("RPC timeout");
    channelA.destroy();
    channelB.destroy();
  });

  it("propagates handler errors as JSON-RPC errors", async () => {
    const { channelA, channelB } = createPair();
    channelB.setRequestHandler(async () => {
      throw new Error("kaboom");
    });
    await expect(channelA.call("health")).rejects.toThrow("kaboom");
    channelA.destroy();
    channelB.destroy();
  });
});
