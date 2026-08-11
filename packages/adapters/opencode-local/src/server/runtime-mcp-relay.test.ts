import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startOpenCodeRuntimeMcpRelay,
  startOpenCodeRuntimeMcpRelays,
  type OpenCodeRuntimeMcpRelay,
} from "./runtime-mcp-relay.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((entry) => entry()));
});

describe("OpenCode runtime MCP relay", () => {
  it("injects the run bearer, strips caller auth, and preserves MCP headers", async () => {
    let observed: {
      authorization?: string;
      proxyAuthorization?: string;
      cookie?: string;
      forwarded?: string;
      paperclipRunId?: string;
      protocolVersion?: string;
      body: string;
    } | null = null;
    const upstream = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      observed = {
        authorization: request.headers.authorization,
        proxyAuthorization: request.headers["proxy-authorization"],
        cookie: request.headers.cookie,
        forwarded: request.headers["x-forwarded-host"] as string | undefined,
        paperclipRunId: request.headers["x-paperclip-run-id"] as string | undefined,
        protocolVersion: request.headers["mcp-protocol-version"] as string | undefined,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      response.writeHead(202, {
        "content-type": "application/json",
        "mcp-session-id": "session-1",
      });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise((resolve) => upstream.close(() => resolve())));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("upstream fixture did not bind");

    const token = "synthetic-run-token";
    const relay = await startOpenCodeRuntimeMcpRelay({
      name: "Exact gateway",
      connectionId: "gateway-1",
      url: `http://127.0.0.1:${address.port}/mcp`,
      token,
    });
    cleanup.push(() => relay.stop());

    const response = await fetch(`${relay.url}?trace=1`, {
      method: "POST",
      headers: {
        authorization: "Bearer caller-controlled",
        "proxy-authorization": "Basic caller-controlled",
        cookie: "session=caller-controlled",
        "x-forwarded-host": "caller-controlled.example.test",
        "x-paperclip-run-id": "caller-controlled-run",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(202);
    expect(response.headers.get("mcp-session-id")).toBe("session-1");
    await expect(response.json()).resolves.toMatchObject({ result: { tools: [] } });
    expect(observed).toEqual({
      authorization: `Bearer ${token}`,
      proxyAuthorization: undefined,
      cookie: undefined,
      forwarded: undefined,
      paperclipRunId: undefined,
      protocolVersion: "2025-06-18",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(JSON.stringify(relay)).not.toContain(token);
    expect(JSON.stringify(relay)).not.toContain(address.port.toString());

    const fixedPathResponse = await fetch(new URL("/mcp", relay.url));
    expect(fixedPathResponse.status).toBe(404);

    await relay.stop();
    await expect(fetch(relay.url)).rejects.toThrow();
  });

  it("stops already-started relays when a later relay fails to start", async () => {
    const stop = vi.fn(async () => undefined);
    const firstRelay: OpenCodeRuntimeMcpRelay = {
      name: "first",
      connectionId: "gateway-1",
      url: "http://127.0.0.1:41001/mcp",
      stop,
    };
    const startRelay = vi.fn()
      .mockResolvedValueOnce(firstRelay)
      .mockRejectedValueOnce(new Error("synthetic startup failure"));
    const servers = [
      {
        name: "first",
        connectionId: "gateway-1",
        url: "https://gateway.example.test/one",
        token: "synthetic-token-one",
      },
      {
        name: "second",
        connectionId: "gateway-2",
        url: "https://gateway.example.test/two",
        token: "synthetic-token-two",
      },
    ];

    await expect(startOpenCodeRuntimeMcpRelays(servers, startRelay)).rejects.toThrow(
      "synthetic startup failure",
    );
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight upstream request when stopped", async () => {
    let markReceived: (() => void) | undefined;
    let markClosed: (() => void) | undefined;
    const received = new Promise<void>((resolve) => { markReceived = resolve; });
    const closed = new Promise<void>((resolve) => { markClosed = resolve; });
    const upstream = http.createServer((_request, response) => {
      markReceived?.();
      response.once("close", () => markClosed?.());
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise((resolve) => upstream.close(() => resolve())));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("upstream fixture did not bind");
    const relay = await startOpenCodeRuntimeMcpRelay({
      name: "Exact gateway",
      connectionId: "gateway-1",
      url: `http://127.0.0.1:${address.port}/mcp`,
      token: "synthetic-run-token",
    });
    cleanup.push(() => relay.stop());

    const request = fetch(relay.url).catch((error: unknown) => error);
    await received;
    await relay.stop();

    await expect(request).resolves.toBeInstanceOf(Error);
    await closed;
  });

  it("aborts only the upstream request when its caller disconnects", async () => {
    let markReceived: (() => void) | undefined;
    let markClosed: (() => void) | undefined;
    const received = new Promise<void>((resolve) => { markReceived = resolve; });
    const closed = new Promise<void>((resolve) => { markClosed = resolve; });
    const upstream = http.createServer((_request, response) => {
      markReceived?.();
      response.once("close", () => markClosed?.());
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise((resolve) => upstream.close(() => resolve())));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("upstream fixture did not bind");
    const relay = await startOpenCodeRuntimeMcpRelay({
      name: "Exact gateway",
      connectionId: "gateway-1",
      url: `http://127.0.0.1:${address.port}/mcp`,
      token: "synthetic-run-token",
    });
    cleanup.push(() => relay.stop());
    const callerAbortController = new AbortController();

    const request = fetch(relay.url, { signal: callerAbortController.signal }).catch(
      (error: unknown) => error,
    );
    await received;
    callerAbortController.abort();

    await expect(request).resolves.toBeInstanceOf(Error);
    await closed;
    const stillListening = await fetch(new URL("/not-the-relay-path", relay.url));
    expect(stillListening.status).toBe(404);
  });
});
