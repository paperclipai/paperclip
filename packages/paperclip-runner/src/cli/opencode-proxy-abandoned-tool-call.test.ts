import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";

import { startOpenCodeMcpBridge, type OpenCodeMcpBridge, type OpenCodeMcpCall } from "../drivers/opencode/mcp-bridge.js";
import { createBackpressuredFrameWriter } from "./opencode-proxy-output.js";

/** A stdout whose reader (runnerd) is waiting on controller acknowledgements. */
class StalledStdout extends EventEmitter {
  readonly lines: string[] = [];
  accepting = false;
  write(chunk: string): boolean {
    this.lines.push(chunk);
    return this.accepting;
  }
  resume(): void {
    this.accepting = true;
    this.emit("drain");
  }
  frames(): Array<Record<string, unknown>> {
    return this.lines.map(line => JSON.parse(line) as Record<string, unknown>);
  }
}

const bridges: OpenCodeMcpBridge[] = [];
afterEach(async () => {
  await Promise.all(bridges.splice(0).map(bridge => bridge.close()));
});

/**
 * Compose the real MCP bridge with the proxy's frame writer the way
 * opencode-app-server-proxy does: a tool call becomes an item/tool/call frame
 * that waits behind earlier event frames until runnerd reads stdout.
 */
async function harness() {
  const stdout = new StalledStdout();
  const writer = createBackpressuredFrameWriter(stdout);
  const outcomes: string[] = [];
  let next = 1;
  const queued = new Set<string>();
  const handler = (call: OpenCodeMcpCall) => new Promise<unknown>((_resolve, reject) => {
    const id = `opencode-${next++}`;
    queued.add(call.callId);
    writer.write({ id, method: "item/tool/call", params: { callId: call.callId, tool: call.tool } }, {
      signal: call.signal,
      onAbandoned: () => {
        outcomes.push(`abandoned:${call.callId}`);
        reject(new Error("abandoned before dispatch"));
      },
    });
  });
  const bridge = await startOpenCodeMcpBridge({
    tools: [{ name: "call_api", inputSchema: { type: "object" } }],
    timeoutMs: null,
    handler,
  });
  bridges.push(bridge);
  const post = (body: Record<string, unknown>, signal?: AbortSignal) => fetch(bridge.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${bridge.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
    signal,
  });
  // OpenCode events that runnerd has not yet read sit ahead of the call.
  writer.write({ method: "item/started", params: { itemId: "backlog" } });
  expect(stdout.lines).toHaveLength(1);
  writer.write({ method: "item/completed", params: { itemId: "backlog" } });
  return { stdout, writer, outcomes, queued, post };
}

const mutatingCall = (id: string) => ({
  id,
  method: "tools/call",
  params: { name: "call_api", arguments: { method: "POST", path: "/tool-gateway/gateways/g/tokens" } },
});

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
}

describe("OpenCode proxy abandoned tool calls", () => {
  it("never hands runnerd a mutating call whose MCP client timed out and cancelled it", async () => {
    const { stdout, outcomes, queued, post } = await harness();
    const response = post(mutatingCall("rotate-token"));
    await until(() => queued.has("rotate-token"));
    // The MCP SDK sends this when its request timeout fires.
    const cancel = await post({
      method: "notifications/cancelled",
      params: { requestId: "rotate-token", reason: "McpError: MCP error -32001: Request timed out" },
    });
    expect(cancel.status).toBe(202);
    const delivered = await (await response).json() as { result: { isError: boolean } };
    expect(delivered.result.isError).toBe(true);
    expect(outcomes).toEqual(["abandoned:rotate-token"]);

    // runnerd finally drains the backlog: it sees the events, never the call.
    stdout.resume();
    expect(stdout.frames().map(frame => frame.method)).toEqual(["item/started", "item/completed"]);
  });

  it("never hands runnerd a call whose MCP client dropped its connection", async () => {
    const { stdout, outcomes, queued, post } = await harness();
    const client = new AbortController();
    const response = post(mutatingCall("dropped"), client.signal);
    await until(() => queued.has("dropped"));
    client.abort();
    await expect(response).rejects.toThrow();
    await until(() => outcomes.length > 0);
    expect(outcomes).toEqual(["abandoned:dropped"]);
    stdout.resume();
    expect(stdout.frames().some(frame => frame.method === "item/tool/call")).toBe(false);
  });

  it("still dispatches a waiting call that its client has not abandoned", async () => {
    const { stdout, outcomes, queued, post } = await harness();
    void post(mutatingCall("live")).catch(() => undefined);
    await until(() => queued.has("live"));
    stdout.resume();
    expect(stdout.frames().map(frame => frame.method)).toEqual(["item/started", "item/completed", "item/tool/call"]);
    expect(outcomes).toEqual([]);
  });
});
