import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { definePlugin, type PluginDefinition } from "../../../packages/plugins/sdk/src/define-plugin.js";
import { startWorkerRpcHost } from "../../../packages/plugins/sdk/src/worker-rpc-host.js";

function fixture(definition: PluginDefinition, rpcTimeoutMs = 30_000) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const worker = startWorkerRpcHost({ plugin: definePlugin(definition), stdin, stdout, rpcTimeoutMs });
  const messages: any[] = [];
  stdout.on("data", (chunk) => { for (const line of String(chunk).trim().split("\n")) messages.push(JSON.parse(line)); });
  let id = 0;
  async function call(method: string, params: unknown = {}) {
    const callId = ++id;
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: callId, method, params }) + "\n");
    await expect.poll(() => messages.find((message) => message.id === callId && !message.method)).toBeDefined();
    return messages.find((message) => message.id === callId && !message.method);
  }
  const initialize = () => call("initialize", { manifest: { id: "test.idle", apiVersion: 1 }, config: {}, apiVersion: 1 });
  return { call, initialize, messages, stdin, close: () => worker.stop() };
}

describe("plugin idle RPC", () => {
  const hold = () => ({ ownerId: "idle-owner", expiresAt: Date.now() + 30_000 });

  it("seals an idle worker, fences stale releases, and restores normal calls", async () => {
    const f = fixture({ async setup() {}, async onIdleDrain() { return "none"; } });
    try {
      expect((await f.initialize()).result.supportedMethods).toContain("prepareIdleSleep");
      const lease = hold();
      expect((await f.call("prepareIdleSleep", lease)).result).toEqual({ ...lease, backgroundWork: "none" });
      expect((await f.call("health")).error).toBeDefined();
      await f.call("releaseIdleSleep", { ownerId: "stale" });
      expect((await f.call("health")).error).toBeDefined();
      await f.call("releaseIdleSleep", lease);
      expect((await f.call("health")).result.status).toBe("ok");
    } finally { f.close(); }
  });

  it("does not mistake a caller timeout for a completed worker handler", async () => {
    let finish!: () => void;
    const f = fixture({ async setup() {}, async onIdleDrain() { return "none"; },
      async onHealth() { await new Promise<void>((resolve) => { finish = resolve; }); return { status: "ok" }; } });
    try {
      await f.initialize();
      const accepted = f.call("health");
      await expect.poll(() => finish).toBeDefined();
      expect((await f.call("prepareIdleSleep", hold())).result.backgroundWork).toBe("present");
      finish(); await accepted;
      expect((await f.call("prepareIdleSleep", hold())).result.backgroundWork).toBe("none");
    } finally { f.close(); }
  });

  it("retains timed-out worker-to-host writes until the host's late receipt", async () => {
    let write!: () => Promise<unknown>;
    const f = fixture({ async setup(ctx) { write = () => ctx.state.set({ scopeKind: "instance", stateKey: "fixture" }, { value: 1 }); },
      async onIdleDrain() { return "none"; } }, 10);
    try {
      await f.initialize();
      await expect(write()).rejects.toThrow("timed out");
      const request = f.messages.find((message) => message.method === "state.set");
      expect((await f.call("prepareIdleSleep", hold())).result.backgroundWork).toBe("present");
      f.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: null }) + "\n");
      expect((await f.call("prepareIdleSleep", hold())).result.backgroundWork).toBe("none");
    } finally { f.close(); }
  });
});
