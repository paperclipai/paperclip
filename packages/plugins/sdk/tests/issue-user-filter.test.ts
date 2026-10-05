import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { definePlugin } from "../src/define-plugin.js";
import { createHostClientHandlers, type HostServices } from "../src/host-client-factory.js";
import { createTestHarness } from "../src/testing.js";
import {
  createErrorResponse,
  createRequest,
  createSuccessResponse,
  isJsonRpcRequest,
  isJsonRpcResponse,
  parseMessage,
  serializeMessage,
  type JsonRpcResponse,
} from "../src/protocol.js";
import { startWorkerRpcHost } from "../src/worker-rpc-host.js";

describe("issue assignee user filter across worker RPC", () => {
  it("returns only the selected user's company issues and filters before pagination", async () => {
    const manifest = {
      id: "paperclip.test-user-filter",
      apiVersion: 1 as const,
      version: "0.1.0",
      displayName: "User Filter",
      description: "Test user-assigned issue lists",
      author: "Paperclip",
      categories: ["automation" as const],
      capabilities: ["issues.read" as const, "issues.create" as const],
      entrypoints: { worker: "./worker.js" },
    };
    const backend = createTestHarness({ manifest });
    for (const [companyId, assigneeUserId, title] of [
      ["company-a", "user-a", "First own task"],
      ["company-a", "user-b", "Other user task"],
      ["company-a", "user-a", "Second own task"],
      ["company-b", "user-a", "Other company task"],
    ]) {
      await backend.ctx.issues.create({ companyId, assigneeUserId, title, status: "todo" });
    }
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.actions.register("waiting", async (params) => {
          const issues = await ctx.issues.list({
            companyId: "company-a",
            assigneeUserId: typeof params.userId === "string" ? params.userId : undefined,
            status: "todo",
            ...(params.page === true ? { offset: 1, limit: 1 } : {}),
          });
          return issues.map((issue) => issue.title);
        });
      },
    });
    const toWorker = new PassThrough();
    const fromWorker = new PassThrough();
    const reader = createInterface({ input: fromWorker });
    const worker = startWorkerRpcHost({ plugin, stdin: toWorker, stdout: fromWorker });
    const handlers = createHostClientHandlers({
      pluginId: manifest.id,
      capabilities: manifest.capabilities,
      services: backend.ctx as unknown as HostServices,
    });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    let nextId = 0;
    reader.on("line", async (line) => {
      const message = parseMessage(line);
      if (isJsonRpcResponse(message)) {
        pending.get(String(message.id))?.(message);
        pending.delete(String(message.id));
      } else if (isJsonRpcRequest(message)) {
        try {
          const handler = handlers[message.method];
          if (!handler) throw new Error(`Unexpected host method: ${message.method}`);
          const result = await handler(message.params as Record<string, unknown>, {
            invocationScope: { companyId: "company-a" },
          });
          toWorker.write(serializeMessage(createSuccessResponse(message.id, result)));
        } catch (error) {
          toWorker.write(serializeMessage(createErrorResponse(message.id, -32000, String(error))));
        }
      }
    });
    function request(method: string, params: unknown): Promise<unknown> {
      const id = `host-${++nextId}`;
      const response = new Promise((resolve, reject) => {
        pending.set(id, (message) => {
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        });
      });
      toWorker.write(serializeMessage(createRequest(method, params, id)));
      return response;
    }
    try {
      await request("initialize", { manifest, config: {}, databaseNamespace: null });
      await expect(request("performAction", { key: "waiting", params: { userId: "user-a" } }))
        .resolves.toEqual(["First own task", "Second own task"]);
      await expect(request("performAction", { key: "waiting", params: { userId: "user-a", page: true } }))
        .resolves.toEqual(["Second own task"]);
      await expect(request("performAction", { key: "waiting", params: { userId: "missing-user" } }))
        .resolves.toEqual([]);
      await expect(request("performAction", { key: "waiting", params: {} }))
        .resolves.toEqual(["First own task", "Other user task", "Second own task"]);
    } finally {
      worker.stop();
      reader.close();
      toWorker.destroy();
      fromWorker.destroy();
    }
  });
});
