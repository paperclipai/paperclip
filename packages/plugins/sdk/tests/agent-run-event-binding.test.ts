import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { definePlugin } from "../src/define-plugin.js";
import {
  createHostClientHandlers,
  type HostServices,
} from "../src/host-client-factory.js";
import {
  createRequest,
  createSuccessResponse,
  isJsonRpcRequest,
  isJsonRpcResponse,
  parseMessage,
  serializeMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type PluginInvocationContext,
  type WorkerHostCallContext,
} from "../src/protocol.js";
import { createTestHarness } from "../src/testing.js";
import type { PaperclipPluginManifestV1, PluginEvent } from "../src/types.js";
import { startWorkerRpcHost } from "../src/worker-rpc-host.js";

const WORKER_MANIFEST = {
  id: "paperclip.test-agent-run-events",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Agent Run Events Test",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["agent.tools.register", "events.emit", "events.subscribe", "jobs.schedule"],
  entrypoints: {},
} satisfies PaperclipPluginManifestV1;

const AGENT_RUN_INVOCATION: PluginInvocationContext = {
  id: "invocation-tool-1",
  scope: {
    companyId: "company-1",
    agentRun: { agentId: "agent-1", runId: "run-1", companyId: "company-1" },
  },
};

const COMPANY_ONLY_INVOCATION: PluginInvocationContext = {
  id: "invocation-event-1",
  scope: { companyId: "company-1" },
};

describe("worker ctx.events.emitFromAgentRun", () => {
  function startWorkerFixture(setup: Parameters<typeof definePlugin>[0]["setup"]) {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    const hostRequests: JsonRpcRequest[] = [];
    let nextRequestId = 1;

    const worker = startWorkerRpcHost({
      plugin: definePlugin({ setup }),
      stdin: hostToWorker,
      stdout: workerToHost,
    });

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (isJsonRpcRequest(message)) {
        // Worker→host call: record it and answer success so the worker settles.
        hostRequests.push(message);
        hostToWorker.write(serializeMessage(createSuccessResponse(message.id, null)));
        return;
      }
      if (!isJsonRpcResponse(message)) return;
      pending.get(String(message.id))?.(message);
      pending.delete(String(message.id));
    });

    function callWorker(method: string, params: unknown, invocation?: PluginInvocationContext) {
      const id = `host-${nextRequestId++}`;
      const request = {
        ...createRequest(method, params, id),
        ...(invocation ? { paperclipInvocation: invocation } : {}),
      };
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) {
            reject(new Error(response.error.message));
            return;
          }
          resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(request));
      return result;
    }

    function stop() {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }

    return { callWorker, hostRequests, stop };
  }

  async function initializeWorker(callWorker: (method: string, params: unknown) => Promise<unknown>) {
    await expect(callWorker("initialize", {
      manifest: WORKER_MANIFEST,
      config: {},
      databaseNamespace: null,
    })).resolves.toMatchObject({ ok: true });
  }

  it("sends only name and payload, echoing the host-issued invocation id", async () => {
    const fixture = startWorkerFixture(async (ctx) => {
      ctx.tools.register(
        "probe",
        { displayName: "Probe", description: "probe", parametersSchema: { type: "object" } },
        async (params) => {
          await ctx.events.emitFromAgentRun("tool-done", params);
          return { content: "ok" };
        },
      );
    });

    try {
      await initializeWorker(fixture.callWorker);

      const spoof = { agentId: "evil", runId: "evil-run", companyId: "evil-co" };
      await expect(fixture.callWorker("executeTool", {
        toolName: "probe",
        parameters: spoof,
        runContext: {
          agentId: "agent-1",
          runId: "run-1",
          companyId: "company-1",
          projectId: "project-1",
        },
      }, AGENT_RUN_INVOCATION)).resolves.toEqual({ content: "ok" });

      const emitRequest = fixture.hostRequests.find(
        (request) => request.method === "events.emitFromAgentRun",
      );
      expect(emitRequest).toBeDefined();
      // Exactly { name, payload } — the worker supplies no identity fields.
      expect(Object.keys(emitRequest!.params as Record<string, unknown>).sort()).toEqual([
        "name",
        "payload",
      ]);
      expect(emitRequest!.params).toEqual({ name: "tool-done", payload: spoof });
      expect(
        (emitRequest as { paperclipInvocationId?: string }).paperclipInvocationId,
      ).toBe(AGENT_RUN_INVOCATION.id);
    } finally {
      fixture.stop();
    }
  });

  it("rejects a timer callback that fires after the executeTool handler has resolved", async () => {
    let timerError: unknown = null;
    const fixture = startWorkerFixture(async (ctx) => {
      ctx.tools.register(
        "probe",
        { displayName: "Probe", description: "probe", parametersSchema: { type: "object" } },
        async () => {
          // Schedule a deferred call — the timer inherits the ALS context of
          // this invocation scope, so `invocationContextStorage` would still
          // report an active agentRun binding when the timer fires. The
          // `executeToolExecutionStorage` completed flag must block it.
          setTimeout(() => {
            ctx.events.emitFromAgentRun("from-timer", {}).catch((err) => {
              timerError = err;
            });
          }, 0);
          // Return before the timer fires.
          return { content: "ok" };
        },
      );
    });

    try {
      await initializeWorker(fixture.callWorker);

      // The executeTool call resolves successfully.
      await expect(fixture.callWorker("executeTool", {
        toolName: "probe",
        parameters: {},
        runContext: {
          agentId: "agent-1",
          runId: "run-1",
          companyId: "company-1",
          projectId: "project-1",
        },
      }, AGENT_RUN_INVOCATION)).resolves.toEqual({ content: "ok" });

      // Give the timer a moment to fire.
      await new Promise((resolve) => setTimeout(resolve, 20));

      // The timer must have been rejected by the completed-flag guard.
      expect(timerError).toBeInstanceOf(Error);
      expect(String(timerError)).toMatch(/executeTool invocation bound to an active agent run/);

      // The host must not have received any emitFromAgentRun request.
      const emitRequests = fixture.hostRequests.filter(
        (request) => request.method === "events.emitFromAgentRun",
      );
      expect(emitRequests).toHaveLength(0);
    } finally {
      fixture.stop();
    }
  });

  it("fails locally inside an invocation that is not bound to an agent run", async () => {
    const fixture = startWorkerFixture(async (ctx) => {
      ctx.events.on("plugin.*", async () => {
        await ctx.events.emitFromAgentRun("laundered", {});
      });
      ctx.tools.register(
        "probe",
        { displayName: "Probe", description: "probe", parametersSchema: { type: "object" } },
        async () => {
          await ctx.events.emitFromAgentRun("tool-done", {});
          return { content: "unreachable" };
        },
      );
    });

    try {
      await initializeWorker(fixture.callWorker);

      // executeTool dispatched under a company-only invocation (no agentRun).
      await expect(fixture.callWorker("executeTool", {
        toolName: "probe",
        parameters: {},
        runContext: {
          agentId: "agent-1",
          runId: "run-1",
          companyId: "company-1",
          projectId: "project-1",
        },
      }, COMPANY_ONLY_INVOCATION)).rejects.toThrow(/executeTool invocation bound to an active agent run/);

      // onEvent deliveries never carry an agent-run binding either. Event
      // handler errors are swallowed by design (logged, delivery continues),
      // so the observable invariant is that no emit call ever reaches the
      // host — asserted below.
      await expect(fixture.callWorker("onEvent", {
        event: {
          eventId: "evt-1",
          eventType: "plugin.other.thing",
          occurredAt: new Date().toISOString(),
          companyId: "company-1",
          payload: { agentId: "agent-1", runId: "run-1" },
        },
      }, COMPANY_ONLY_INVOCATION)).resolves.toBeNull();

      expect(
        fixture.hostRequests.filter((request) => request.method === "events.emitFromAgentRun"),
      ).toHaveLength(0);
    } finally {
      fixture.stop();
    }
  });
});

describe("host factory events.emitFromAgentRun gate", () => {
  function buildHandlers(options?: { capabilities?: PaperclipPluginManifestV1["capabilities"] }) {
    const emitFromAgentRun = vi.fn(async () => undefined);
    const handlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: options?.capabilities ?? ["events.emit"],
      services: {
        events: {
          emit: vi.fn(async () => undefined),
          emitFromAgentRun,
          subscribe: vi.fn(async () => undefined),
        },
      } as unknown as HostServices,
    });
    return { handlers, emitFromAgentRun };
  }

  const validContext: WorkerHostCallContext = {
    invocationScope: {
      companyId: "company-1",
      agentRun: { agentId: "agent-1", runId: "run-1", companyId: "company-1" },
    },
  };

  it("requires the events.emit capability", async () => {
    const { handlers, emitFromAgentRun } = buildHandlers({ capabilities: [] });
    await expect(
      handlers["events.emitFromAgentRun"]({ name: "x", payload: {} }, validContext),
    ).rejects.toMatchObject({ name: "CapabilityDeniedError" });
    expect(emitFromAgentRun).not.toHaveBeenCalled();
  });

  it("rejects missing, expired, or forged invocations", async () => {
    const { handlers, emitFromAgentRun } = buildHandlers();
    await expect(
      handlers["events.emitFromAgentRun"]({ name: "x", payload: {} }, {
        invalidInvocationScope: true,
      }),
    ).rejects.toMatchObject({
      name: "InvocationScopeDeniedError",
      message: expect.stringContaining("unknown invocation scope"),
    });
    await expect(
      handlers["events.emitFromAgentRun"]({ name: "x", payload: {} }, undefined),
    ).rejects.toMatchObject({ name: "InvocationScopeDeniedError" });
    expect(emitFromAgentRun).not.toHaveBeenCalled();
  });

  it("rejects invocations without an agent-run binding", async () => {
    const { handlers, emitFromAgentRun } = buildHandlers();
    await expect(
      handlers["events.emitFromAgentRun"]({ name: "x", payload: {} }, {
        invocationScope: { companyId: "company-1" },
      }),
    ).rejects.toMatchObject({
      name: "InvocationScopeDeniedError",
      message: expect.stringContaining("agent run"),
    });
    expect(emitFromAgentRun).not.toHaveBeenCalled();
  });

  it("routes only name and payload to the service with the host-owned scope", async () => {
    const { handlers, emitFromAgentRun } = buildHandlers();
    const payload = { producer: { agentId: "evil" }, extra: 1 };
    await handlers["events.emitFromAgentRun"](
      // A hostile worker may attach extra top-level fields; they must not reach
      // the service.
      { name: "tool-done", payload, junk: "ignored" } as never,
      validContext,
    );
    expect(emitFromAgentRun).toHaveBeenCalledTimes(1);
    const [params, context] = emitFromAgentRun.mock.calls[0]! as [
      Record<string, unknown>,
      WorkerHostCallContext,
    ];
    expect(Object.keys(params).sort()).toEqual(["name", "payload"]);
    expect(params).toEqual({ name: "tool-done", payload });
    expect(context).toBe(validContext);
  });

  it("denies a spoofed top-level companyId outside the invocation scope", async () => {
    const { handlers, emitFromAgentRun } = buildHandlers();
    await expect(
      handlers["events.emitFromAgentRun"](
        { name: "x", payload: {}, companyId: "company-2" } as never,
        validContext,
      ),
    ).rejects.toMatchObject({ name: "InvocationScopeDeniedError" });
    expect(emitFromAgentRun).not.toHaveBeenCalled();
  });
});

describe("test harness emitFromAgentRun", () => {
  it("delivers a host-owned envelope derived from the executeTool run context", async () => {
    const harness = createTestHarness({ manifest: WORKER_MANIFEST });
    const received: PluginEvent[] = [];
    harness.ctx.events.on("plugin.*", async (event) => {
      received.push(event);
    });
    harness.ctx.tools.register(
      "probe",
      { displayName: "Probe", description: "probe", parametersSchema: { type: "object" } },
      async (params) => {
        await harness.ctx.events.emitFromAgentRun("tool-done", params);
        return { content: "ok" };
      },
    );

    const spoof = {
      companyId: "evil-company",
      producer: { kind: "agent_run", agentId: "evil", runId: "evil-run" },
    };
    await harness.executeTool("probe", spoof, {
      agentId: "agent-1",
      runId: "run-1",
      companyId: "company-1",
    });

    expect(received).toHaveLength(1);
    const event = received[0]!;
    expect(event.eventType).toBe(`plugin.${WORKER_MANIFEST.id}.tool-done`);
    expect(event.companyId).toBe("company-1");
    expect(event.producer).toEqual({ kind: "agent_run", agentId: "agent-1", runId: "run-1" });
    expect(event.eventId).not.toBe("evil-run");
    expect(event.payload).toEqual(spoof);
  });

  it("fails outside executeTool, including scheduled job runs", async () => {
    const harness = createTestHarness({ manifest: WORKER_MANIFEST });
    let jobError: unknown = null;
    harness.ctx.jobs.register("sync", async () => {
      try {
        await harness.ctx.events.emitFromAgentRun("from-job", {});
      } catch (err) {
        jobError = err;
      }
    });

    await expect(
      harness.ctx.events.emitFromAgentRun("direct", {}),
    ).rejects.toThrow(/executeTool invocation bound to an active agent run/);

    await harness.runJob("sync");
    expect(jobError).toBeInstanceOf(Error);
    expect(String(jobError)).toMatch(/executeTool invocation bound to an active agent run/);
  });
});
