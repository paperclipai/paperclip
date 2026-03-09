import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import {
  startWorkerRpcHost,
  definePlugin,
  JSONRPC_VERSION,
} from "@paperclipai/plugin-sdk";
import type {
  InitializeParams,
  WorkerRpcHost,
  PaperclipPluginManifestV1,
} from "@paperclipai/plugin-sdk";

class MockStdio {
  workerStdin: PassThrough;
  workerStdout: PassThrough;
  private _outBuffer = "";
  private _outWaiters: Array<(data: string) => void> = [];

  constructor() {
    this.workerStdin = new PassThrough();
    this.workerStdout = new PassThrough();
    this.workerStdout.on("data", (chunk: Buffer) => {
      this._outBuffer += chunk.toString();
      this._flushWaiters();
    });
  }

  private _flushWaiters(): void {
    while (this._outWaiters.length > 0 && this._outBuffer.includes("\n")) {
      const idx = this._outBuffer.indexOf("\n");
      const line = this._outBuffer.slice(0, idx);
      this._outBuffer = this._outBuffer.slice(idx + 1);
      const waiter = this._outWaiters.shift()!;
      waiter(line);
    }
  }

  sendToWorker(message: unknown): void {
    this.workerStdin.write(JSON.stringify(message) + "\n");
  }

  readNextMessage<T = unknown>(): Promise<T> {
    return new Promise((resolve) => {
      if (this._outBuffer.includes("\n")) {
        const idx = this._outBuffer.indexOf("\n");
        const line = this._outBuffer.slice(0, idx);
        this._outBuffer = this._outBuffer.slice(idx + 1);
        resolve(JSON.parse(line) as T);
      } else {
        this._outWaiters.push((line) => resolve(JSON.parse(line) as T));
      }
    });
  }

  async initialize(): Promise<void> {
    const manifest: PaperclipPluginManifestV1 = {
      id: "test.plugin",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Test",
      description: "Test",
      categories: ["connector"],
      capabilities: ["events.subscribe"],
      entrypoints: { worker: "worker.js" },
    };
    const params: InitializeParams = {
      manifest,
      config: {},
      instanceInfo: { instanceId: "inst-1", hostVersion: "1.0.0" },
      apiVersion: 1,
    };
    this.sendToWorker({ jsonrpc: JSONRPC_VERSION, id: 1, method: "initialize", params });
    await this.readNextMessage();
  }

  destroy(): void {
    this.workerStdin.destroy();
    this.workerStdout.destroy();
  }
}

describe("worker-rpc-host allowsEvent filtering", () => {
  let stdio: MockStdio;
  let host: WorkerRpcHost;

  beforeEach(async () => {
    stdio = new MockStdio();
    vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    if (host?.running) host.stop();
    stdio.destroy();
    vi.restoreAllMocks();
  });

  it("filters events by companyId in payload", async () => {
    const handler = vi.fn();
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.events.on("issue.created", { companyId: "co-1" }, handler);
      },
    });

    host = startWorkerRpcHost({ plugin, stdin: stdio.workerStdin, stdout: stdio.workerStdout });
    await stdio.initialize();

    // Match
    await stdio.sendToWorker({
      jsonrpc: JSONRPC_VERSION, id: 2, method: "onEvent",
      params: { event: { eventType: "issue.created", payload: { companyId: "co-1" } } }
    });
    await stdio.readNextMessage();
    expect(handler).toHaveBeenCalledTimes(1);

    // No match
    await stdio.sendToWorker({
      jsonrpc: JSONRPC_VERSION, id: 3, method: "onEvent",
      params: { event: { eventType: "issue.created", payload: { companyId: "co-2" } } }
    });
    await stdio.readNextMessage();
    expect(handler).toHaveBeenCalledTimes(1); // Still 1
  });

  it("filters events by projectId in payload", async () => {
    const handler = vi.fn();
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.events.on("issue.created", { projectId: "proj-1" }, handler);
      },
    });

    host = startWorkerRpcHost({ plugin, stdin: stdio.workerStdin, stdout: stdio.workerStdout });
    await stdio.initialize();

    // Match via payload
    await stdio.sendToWorker({
      jsonrpc: JSONRPC_VERSION, id: 2, method: "onEvent",
      params: { event: { eventType: "issue.created", payload: { projectId: "proj-1" } } }
    });
    await stdio.readNextMessage();
    expect(handler).toHaveBeenCalledTimes(1);

    // No match
    await stdio.sendToWorker({
      jsonrpc: JSONRPC_VERSION, id: 3, method: "onEvent",
      params: { event: { eventType: "issue.created", payload: { projectId: "proj-2" } } }
    });
    await stdio.readNextMessage();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("filters events by projectId via top-level entityId", async () => {
    const handler = vi.fn();
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.events.on("project.updated", { projectId: "proj-1" }, handler);
      },
    });

    host = startWorkerRpcHost({ plugin, stdin: stdio.workerStdin, stdout: stdio.workerStdout });
    await stdio.initialize();

    // Match via entityId (when entityType is 'project')
    await stdio.sendToWorker({
      jsonrpc: JSONRPC_VERSION, id: 2, method: "onEvent",
      params: { event: { eventType: "project.updated", entityType: "project", entityId: "proj-1", payload: {} } }
    });
    await stdio.readNextMessage();
    expect(handler).toHaveBeenCalledTimes(1);

    // No match via entityId
    await stdio.sendToWorker({
      jsonrpc: JSONRPC_VERSION, id: 3, method: "onEvent",
      params: { event: { eventType: "project.updated", entityType: "project", entityId: "proj-2", payload: {} } }
    });
    await stdio.readNextMessage();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("filters events by agentId via top-level entityId", async () => {
    const handler = vi.fn();
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.events.on("agent.updated", { agentId: "agent-1" }, handler);
      },
    });

    host = startWorkerRpcHost({ plugin, stdin: stdio.workerStdin, stdout: stdio.workerStdout });
    await stdio.initialize();

    // Match via entityId (when entityType is 'agent')
    await stdio.sendToWorker({
      jsonrpc: JSONRPC_VERSION, id: 2, method: "onEvent",
      params: { event: { eventType: "agent.updated", entityType: "agent", entityId: "agent-1", payload: {} } }
    });
    await stdio.readNextMessage();
    expect(handler).toHaveBeenCalledTimes(1);

    // No match via entityId
    await stdio.sendToWorker({
      jsonrpc: JSONRPC_VERSION, id: 3, method: "onEvent",
      params: { event: { eventType: "agent.updated", entityType: "agent", entityId: "agent-2", payload: {} } }
    });
    await stdio.readNextMessage();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("filters events by agentId in payload", async () => {
    const handler = vi.fn();
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.events.on("some.event", { agentId: "agent-1" }, handler);
      },
    });

    host = startWorkerRpcHost({ plugin, stdin: stdio.workerStdin, stdout: stdio.workerStdout });
    await stdio.initialize();

    // Match via payload
    await stdio.sendToWorker({
      jsonrpc: JSONRPC_VERSION, id: 2, method: "onEvent",
      params: { event: { eventType: "some.event", payload: { agentId: "agent-1" } } }
    });
    await stdio.readNextMessage();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
