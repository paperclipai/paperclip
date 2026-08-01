import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1, PluginCapability } from "@paperclipai/shared";
import {
  createHostClientHandlers,
  PLUGIN_RPC_ERROR_CODES,
  type HostServices,
  type HostToWorkerMethods,
  type PluginEvent,
} from "@paperclipai/plugin-sdk";
import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";
import { createPluginEventBus } from "../services/plugin-event-bus.js";
import {
  AGENT_RUN_EVENT_TERMINAL_STATUSES,
  assertLiveAgentRunBinding,
} from "../services/plugin-host-services.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const AGENT_RUN_EVENTS_WORKER_ENTRYPOINT = path.join(
  FIXTURES_DIR,
  "plugin-worker-agent-run-events.cjs",
);

const TEST_MANIFEST: PaperclipPluginManifestV1 = {
  id: "test.plugin",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test plugin",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["events.emit"],
  entrypoints: { worker: "dist/worker.js" },
};

const RUN_CONTEXT = {
  agentId: "agent-1",
  runId: "run-1",
  companyId: "company-1",
  projectId: "project-1",
};

function createEmitHandle(options?: {
  capabilities?: PluginCapability[];
  emitFromAgentRun?: ReturnType<typeof vi.fn>;
}) {
  const emitFromAgentRun = options?.emitFromAgentRun ?? vi.fn(async () => undefined);
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
  const handle = createPluginWorkerHandle("test.plugin", {
    entrypointPath: AGENT_RUN_EVENTS_WORKER_ENTRYPOINT,
    manifest: TEST_MANIFEST,
    config: {},
    instanceInfo: {
      instanceId: "instance-1",
      hostVersion: "1.0.0",
    },
    apiVersion: 1,
    hostHandlers: handlers,
  });
  return { handle, emitFromAgentRun };
}

describe("plugin events bound to active agent runs (worker manager + factory)", () => {
  it("binds executeTool invocations to the host-owned agent run scope", async () => {
    const { handle, emitFromAgentRun } = createEmitHandle();
    // Payload actively tries to spoof every identity the host derives.
    const spoofPayload = {
      agentId: "evil-agent",
      runId: "evil-run",
      companyId: "evil-company",
      eventId: "evil-event",
      producer: { kind: "agent_run", agentId: "evil-agent", runId: "evil-run" },
    };

    try {
      await handle.start();

      await expect(handle.call("executeTool", {
        toolName: "probe",
        parameters: { mode: "echo", payload: spoofPayload },
        runContext: RUN_CONTEXT,
      })).resolves.toEqual({ data: "emitted" });

      expect(emitFromAgentRun).toHaveBeenCalledTimes(1);
      const [params, context] = emitFromAgentRun.mock.calls[0]!;
      // The worker supplies only name + payload — no identity fields.
      expect(Object.keys(params as Record<string, unknown>).sort()).toEqual(["name", "payload"]);
      expect(params).toEqual({ name: "tool-done", payload: spoofPayload });
      // The scope is host-owned and matches the dispatched run context exactly,
      // regardless of what the payload claimed.
      expect(context).toEqual({
        invocationScope: {
          companyId: "company-1",
          agentRun: { agentId: "agent-1", runId: "run-1", companyId: "company-1" },
        },
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("does not launder provenance through onEvent invocations", async () => {
    const { handle, emitFromAgentRun } = createEmitHandle();

    try {
      await handle.start();

      await expect(handle.call("onEvent", {
        event: {
          eventId: "evt-1",
          eventType: "issue.created",
          occurredAt: new Date().toISOString(),
          companyId: "company-1",
          // Run identifiers inside the event payload must not create a binding.
          payload: { agentId: "agent-1", runId: "run-1" },
        },
      } as HostToWorkerMethods["onEvent"][0])).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
        message: expect.stringContaining("agent run"),
      });

      expect(emitFromAgentRun).not.toHaveBeenCalled();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("rejects job runs — a plugin job run is not an agent run", async () => {
    const { handle, emitFromAgentRun } = createEmitHandle();

    try {
      await handle.start();

      await expect(handle.call("runJob", {
        job: {
          jobKey: "sync",
          runId: "job-run-1",
          trigger: "schedule",
          scheduledAt: new Date().toISOString(),
        },
      } as HostToWorkerMethods["runJob"][0])).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
      });

      expect(emitFromAgentRun).not.toHaveBeenCalled();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("rejects forged invocation ids", async () => {
    const { handle, emitFromAgentRun } = createEmitHandle();

    try {
      await handle.start();

      await expect(handle.call("executeTool", {
        toolName: "probe",
        parameters: { mode: "unknown" },
        runContext: RUN_CONTEXT,
      })).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
        message: expect.stringContaining("unknown invocation scope"),
      });

      expect(emitFromAgentRun).not.toHaveBeenCalled();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("rejects expired invocation ids after the executeTool call settles", async () => {
    const { handle, emitFromAgentRun } = createEmitHandle();

    try {
      await handle.start();

      // A legitimate executeTool call completes, which clears its invocation.
      await expect(handle.call("executeTool", {
        toolName: "probe",
        parameters: { mode: "echo" },
        runContext: RUN_CONTEXT,
      })).resolves.toEqual({ data: "emitted" });
      expect(emitFromAgentRun).toHaveBeenCalledTimes(1);

      // The fixture then replays the settled invocation id from a getData call.
      await expect(handle.call("getData", {
        key: "probe",
        companyId: "company-1",
        params: { mode: "stale" },
      } as HostToWorkerMethods["getData"][0])).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
      });
      expect(emitFromAgentRun).toHaveBeenCalledTimes(1);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("requires the events.emit capability", async () => {
    const { handle, emitFromAgentRun } = createEmitHandle({ capabilities: [] });

    try {
      await handle.start();

      await expect(handle.call("executeTool", {
        toolName: "probe",
        parameters: { mode: "echo" },
        runContext: RUN_CONTEXT,
      })).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED,
      });

      expect(emitFromAgentRun).not.toHaveBeenCalled();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});

describe("plugin event bus producer provenance", () => {
  it("delivers an exact host-owned envelope that payload spoofing cannot alter", async () => {
    const bus = createPluginEventBus();
    const received: PluginEvent[] = [];
    bus.forPlugin("observer.plugin").subscribe("plugin.acme.linear.*", async (event) => {
      received.push(event);
    });

    const spoofPayload = {
      eventId: "evil-event",
      companyId: "evil-company",
      actorId: "evil-actor",
      producer: { kind: "agent_run", agentId: "evil-agent", runId: "evil-run" },
      prompt: "payload contents stay opaque",
    };
    const producer = { kind: "agent_run" as const, agentId: "agent-1", runId: "run-1" };
    await bus.forPlugin("acme.linear").emit("sync-done", "company-1", spoofPayload, { producer });

    expect(received).toHaveLength(1);
    const event = received[0]!;
    // Exact envelope: nothing beyond these host-owned fields plus the payload.
    expect(Object.keys(event).sort()).toEqual([
      "actorId",
      "actorType",
      "companyId",
      "eventId",
      "eventType",
      "occurredAt",
      "payload",
      "producer",
    ]);
    expect(event.eventType).toBe("plugin.acme.linear.sync-done");
    expect(event.companyId).toBe("company-1");
    expect(event.actorType).toBe("plugin");
    expect(event.actorId).toBe("acme.linear");
    expect(event.producer).toEqual(producer);
    // eventId is freshly minted — distinct from the run and from spoof attempts.
    expect(event.eventId).not.toBe("evil-event");
    expect(event.eventId).not.toBe(producer.runId);
    expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/);
    // The payload is delivered verbatim but stays inside `payload`.
    expect(event.payload).toEqual(spoofPayload);
  });

  it("mints a distinct eventId per emit and omits producer without host options", async () => {
    const bus = createPluginEventBus();
    const received: PluginEvent[] = [];
    bus.forPlugin("observer.plugin").subscribe("plugin.acme.linear.*", async (event) => {
      received.push(event);
    });

    const producer = { kind: "agent_run" as const, agentId: "agent-1", runId: "run-1" };
    await bus.forPlugin("acme.linear").emit("sync-done", "company-1", {}, { producer });
    await bus.forPlugin("acme.linear").emit("sync-done", "company-1", {}, { producer });
    await bus.forPlugin("acme.linear").emit("sync-done", "company-1", {});

    expect(received).toHaveLength(3);
    expect(received[0]!.eventId).not.toBe(received[1]!.eventId);
    expect(received[2]!.producer).toBeUndefined();
    expect("producer" in received[2]!).toBe(false);
  });
});

describe("assertLiveAgentRunBinding", () => {
  const expected = { agentId: "agent-1", runId: "run-1", companyId: "company-1" };
  const liveRun = {
    id: "run-1",
    companyId: "company-1",
    agentId: "agent-1",
    status: "running",
  };

  it("accepts a live run owned by the same company and agent", () => {
    expect(() => assertLiveAgentRunBinding(liveRun, expected)).not.toThrow();
    expect(() =>
      assertLiveAgentRunBinding({ ...liveRun, status: "queued" }, expected),
    ).not.toThrow();
  });

  it("rejects a missing run — job runs and forged ids never exist in heartbeat_runs", () => {
    expect(() => assertLiveAgentRunBinding(null, expected)).toThrow(/not an agent run/);
  });

  it("rejects cross-company runs", () => {
    expect(() =>
      assertLiveAgentRunBinding({ ...liveRun, companyId: "company-2" }, expected),
    ).toThrow(/different company/);
  });

  it("rejects cross-agent runs", () => {
    expect(() =>
      assertLiveAgentRunBinding({ ...liveRun, agentId: "agent-2" }, expected),
    ).toThrow(/different agent/);
  });

  it("rejects every terminal status", () => {
    for (const status of AGENT_RUN_EVENT_TERMINAL_STATUSES) {
      expect(() =>
        assertLiveAgentRunBinding({ ...liveRun, status }, expected),
      ).toThrow(/terminal/);
    }
  });
});
