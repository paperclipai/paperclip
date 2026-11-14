import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { definePlugin } from "../src/define-plugin.js";
import {
  createErrorResponse,
  createRequest,
  createSuccessResponse,
  isJsonRpcRequest,
  JSONRPC_ERROR_CODES,
  isJsonRpcResponse,
  parseMessage,
  serializeMessage,
  type JsonRpcResponse,
} from "../src/protocol.js";
import type { PluginContext, PluginEvent } from "../src/types.js";
import { startWorkerRpcHost } from "../src/worker-rpc-host.js";

const manifest = {
  id: "test.event-fanout",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Event Fanout",
  description: "Test",
  author: "Tests",
  categories: ["automation"],
  capabilities: ["events.subscribe"],
  entrypoints: { worker: "worker.js" },
};

function makeEvent(overrides: Partial<PluginEvent> = {}): PluginEvent {
  return {
    eventId: "event-1",
    eventType: "issue.created",
    occurredAt: new Date(0).toISOString(),
    companyId: "company-a",
    payload: {},
    ...overrides,
  };
}

async function withWorker(
  setup: (ctx: PluginContext) => void,
  run: (helpers: {
    call: (method: string, params: unknown) => Promise<JsonRpcResponse>;
    hostCalls: Array<{ method: string; params: unknown }>;
  }) => Promise<void>,
  denySubscribe?: (params: unknown) => string | undefined,
) {
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = createInterface({ input: output });
  const hostCalls: Array<{ method: string; params: unknown }> = [];
  const pending = new Map<string, (value: JsonRpcResponse) => void>();
  let sequence = 0;
  const plugin = definePlugin({
    async setup(ctx) {
      setup(ctx);
    },
  });
  const worker = startWorkerRpcHost({ plugin, stdin: input, stdout: output });
  reader.on("line", (line) => {
    const message = parseMessage(line);
    if (isJsonRpcResponse(message)) {
      pending.get(String(message.id))?.(message);
      pending.delete(String(message.id));
    } else if (isJsonRpcRequest(message)) {
      hostCalls.push({ method: message.method, params: message.params });
      const denied = denySubscribe?.(message.params);
      input.write(serializeMessage(
        denied
          ? createErrorResponse(message.id, JSONRPC_ERROR_CODES.INTERNAL_ERROR, denied)
          : createSuccessResponse(message.id, null),
      ));
    }
  });
  const call = (method: string, params: unknown) =>
    new Promise<JsonRpcResponse>((resolve) => {
      const id = String(++sequence);
      pending.set(id, resolve);
      input.write(serializeMessage(createRequest(method, params, id)));
    });
  try {
    await call("initialize", { manifest, config: {}, databaseNamespace: null });
    await run({ call, hostCalls });
  } finally {
    worker.stop();
    reader.close();
    input.destroy();
    output.destroy();
  }
}

describe("worker event subscription fan-out", () => {
  it("subscribes once per event name and runs each handler once per event", async () => {
    const runs: string[] = [];
    await withWorker(
      (ctx) => {
        ctx.events.on("issue.created", async () => { runs.push("a"); });
        ctx.events.on("issue.created", async () => { runs.push("b"); });
      },
      async ({ call, hostCalls }) => {
        await call("onEvent", { event: makeEvent() });
        expect(hostCalls.filter((c) => c.method === "events.subscribe")).toEqual([
          { method: "events.subscribe", params: { eventPattern: "issue.created", filter: null } },
        ]);
        expect(runs.sort()).toEqual(["a", "b"]);
      },
    );
  });

  it("applies per-handler filters on the worker side", async () => {
    const runs: string[] = [];
    await withWorker(
      (ctx) => {
        ctx.events.on("issue.created", { projectId: "project-a" }, async () => { runs.push("filtered"); });
        ctx.events.on("issue.created", async () => { runs.push("all"); });
      },
      async ({ call }) => {
        await call("onEvent", { event: makeEvent({ payload: { projectId: "project-b" } }) });
        expect(runs).toEqual(["all"]);
      },
    );
  });

  it("runs handlers once when overlapping wildcard subscriptions deliver the same event", async () => {
    const runs: string[] = [];
    await withWorker(
      (ctx) => {
        ctx.events.on("plugin.*", async () => { runs.push("all"); });
        ctx.events.on("plugin.acme.*", async () => { runs.push("acme"); });
      },
      async ({ call }) => {
        const event = makeEvent({ eventId: "event-2", eventType: "plugin.acme.thing" });
        await call("onEvent", { event });
        await call("onEvent", { event });
        expect(runs.sort()).toEqual(["acme", "all"]);
      },
    );
  });

  it("sends a companyId filter to the host once per name and company", async () => {
    const runs: string[] = [];
    await withWorker(
      (ctx) => {
        ctx.events.on("issue.created", { companyId: "company-a" }, async () => { runs.push("a1"); });
        ctx.events.on("issue.created", { companyId: "company-a", projectId: "project-a" }, async () => { runs.push("a2"); });
        ctx.events.on("issue.created", async () => { runs.push("all"); });
      },
      async ({ call, hostCalls }) => {
        await call("onEvent", { event: makeEvent({ payload: { projectId: "project-a" } }) });
        expect(hostCalls.filter((c) => c.method === "events.subscribe")).toEqual([
          { method: "events.subscribe", params: { eventPattern: "issue.created", filter: { companyId: "company-a" } } },
          { method: "events.subscribe", params: { eventPattern: "issue.created", filter: null } },
        ]);
        expect(runs.sort()).toEqual(["a1", "a2", "all"]);
      },
    );
  });

  it("drops a filtered handler when the host rejects its company filter", async () => {
    const runs: string[] = [];
    await withWorker(
      (ctx) => {
        ctx.events.on("issue.created", { companyId: "company-b" }, async () => { runs.push("b"); });
        ctx.events.on("issue.created", { companyId: "company-a" }, async () => { runs.push("a"); });
      },
      async ({ call }) => {
        await call("onEvent", { event: makeEvent({ companyId: "company-b", payload: { companyId: "company-b" } }) });
        expect(runs).toEqual([]);
        await call("onEvent", { event: makeEvent({ eventId: "event-2", payload: { companyId: "company-a" } }) });
        expect(runs).toEqual(["a"]);
      },
      (params) => {
        const filter = (params as { filter?: { companyId?: string } | null }).filter;
        return filter?.companyId === "company-b" ? "company scope denied" : undefined;
      },
    );
  });
});
