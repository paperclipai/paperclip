import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, JSONRPCRequest, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  CallerGuardingTransport,
  extractCallerHeaders,
  readCallerGuardConfigFromEnv,
  validateCallerGuard,
} from "./stdio.js";

class FakeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  readonly sent: JSONRPCMessage[] = [];

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(message);
  }

  async close(): Promise<void> {
    this.onclose?.();
  }

  dispatch(message: JSONRPCMessage, extra?: MessageExtraInfo) {
    this.onmessage?.(message, extra);
  }
}

function makeToolCallRequest(meta?: Record<string, unknown>): JSONRPCRequest {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "paperclipUpdateIssue",
      arguments: {},
      _meta: meta,
    },
  };
}

describe("stdio caller guard", () => {
  it("stays disabled when no guard env is configured", () => {
    const config = readCallerGuardConfigFromEnv({});
    expect(config.enabled).toBe(false);
    expect(config.allowedCallerIds.size).toBe(0);
    expect(config.expectedCallerEnv).toBeNull();
  });

  it("reads caller headers from JSON-RPC metadata headers", () => {
    const headers = extractCallerHeaders(
      makeToolCallRequest({
        headers: {
          "X-Paperclip-Caller-Id": "storefront-search",
          "x-paperclip-caller-env": "staging",
        },
      }),
    );

    expect(headers).toEqual({
      callerId: "storefront-search",
      callerEnv: "staging",
    });
  });

  it("rejects tool calls from disallowed callers before forwarding the request", async () => {
    const inner = new FakeTransport();
    const transport = new CallerGuardingTransport(inner, {
      enabled: true,
      allowedCallerIds: new Set(["allowed-caller"]),
      expectedCallerEnv: null,
    });
    const onmessage = vi.fn();
    transport.onmessage = onmessage;

    await transport.start();
    inner.dispatch(
      makeToolCallRequest({
        headers: {
          "x-paperclip-caller-id": "blocked-caller",
        },
      }),
    );

    expect(onmessage).not.toHaveBeenCalled();
    expect(inner.sent).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: 403,
          message: 'Forbidden: caller "blocked-caller" is not allowed',
        },
      },
    ]);
  });

  it("rejects tool calls when the caller environment mismatches", () => {
    const message = validateCallerGuard(
      makeToolCallRequest({
        headers: {
          "x-paperclip-caller-id": "allowed-caller",
          "x-paperclip-caller-env": "development",
        },
      }),
      {
        enabled: true,
        allowedCallerIds: new Set(["allowed-caller"]),
        expectedCallerEnv: "production",
      },
    );

    expect(message).toBe(
      'Forbidden: caller environment "development" does not match expected "production"',
    );
  });

  it("lets non-tool requests through even when the guard is enabled", async () => {
    const inner = new FakeTransport();
    const transport = new CallerGuardingTransport(inner, {
      enabled: true,
      allowedCallerIds: new Set(["allowed-caller"]),
      expectedCallerEnv: "staging",
    });
    const onmessage = vi.fn();
    transport.onmessage = onmessage;

    await transport.start();
    inner.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        clientInfo: { name: "test", version: "1.0.0" },
        capabilities: {},
      },
    });

    expect(onmessage).toHaveBeenCalledTimes(1);
    expect(inner.sent).toEqual([]);
  });
});