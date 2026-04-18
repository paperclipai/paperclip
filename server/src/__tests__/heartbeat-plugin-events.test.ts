import { describe, expect, it, vi } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import {
  emitRunStatusPluginEvent,
  mapRunStatusToPluginEvent,
  type HeartbeatRunForPluginEvent,
} from "../services/heartbeat.ts";
import type { PluginEventBus } from "../services/plugin-event-bus.js";

function buildRun(overrides: Partial<HeartbeatRunForPluginEvent> = {}): HeartbeatRunForPluginEvent {
  return {
    id: "run-1",
    companyId: "company-1",
    agentId: "agent-1",
    status: "running",
    startedAt: new Date("2026-04-17T10:00:00Z"),
    finishedAt: null,
    error: null,
    errorCode: null,
    ...overrides,
  };
}

function makeMockBus(): {
  bus: PluginEventBus;
  calls: PluginEvent[];
  emit: ReturnType<typeof vi.fn>;
} {
  const calls: PluginEvent[] = [];
  const emit = vi.fn(async (event: PluginEvent) => {
    calls.push(event);
    return { errors: [] as Array<{ pluginId: string; error: Error }> };
  });
  // Only the `emit` method is used by emitRunStatusPluginEvent; the rest of the
  // PluginEventBus surface is deliberately not stubbed.
  const bus = { emit } as unknown as PluginEventBus;
  return { bus, calls, emit };
}

describe("mapRunStatusToPluginEvent", () => {
  it("maps the four observable statuses", () => {
    expect(mapRunStatusToPluginEvent("running")).toBe("agent.run.started");
    expect(mapRunStatusToPluginEvent("finished")).toBe("agent.run.finished");
    expect(mapRunStatusToPluginEvent("failed")).toBe("agent.run.failed");
    expect(mapRunStatusToPluginEvent("cancelled")).toBe("agent.run.cancelled");
  });

  it("returns null for intermediate / unmapped statuses", () => {
    expect(mapRunStatusToPluginEvent("pending")).toBeNull();
    expect(mapRunStatusToPluginEvent("queued")).toBeNull();
    expect(mapRunStatusToPluginEvent("")).toBeNull();
    expect(mapRunStatusToPluginEvent("anything-else")).toBeNull();
  });
});

describe("emitRunStatusPluginEvent", () => {
  it("emits agent.run.started for the queued→running claim transition", async () => {
    // Regression guard for the site in heartbeat.ts that bypasses setRunStatus()
    // when claiming a queued run. The same emitRunStatusPluginEvent helper is
    // used there, so the shape must be identical to the setRunStatus path.
    const { bus, calls } = makeMockBus();
    emitRunStatusPluginEvent(
      bus,
      buildRun({
        status: "running",
        startedAt: new Date("2026-04-17T10:00:00Z"),
        finishedAt: null,
      }),
    );
    await new Promise((r) => setImmediate(r));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.eventType).toBe("agent.run.started");
    expect(calls[0]?.occurredAt).toBe("2026-04-17T10:00:00.000Z");
  });

  it("emits agent.run.started when transitioning to running", async () => {
    const { bus, calls, emit } = makeMockBus();
    emitRunStatusPluginEvent(bus, buildRun({ status: "running" }));
    // fire-and-forget: allow the microtask to flush
    await new Promise((r) => setImmediate(r));

    expect(emit).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    const event = calls[0]!;
    expect(event.eventType).toBe("agent.run.started");
    expect(event.entityId).toBe("run-1");
    expect(event.entityType).toBe("agent_run");
    expect(event.companyId).toBe("company-1");
    expect(event.actorId).toBeUndefined();
    expect(event.actorType).toBeUndefined();
    expect(event.payload).toMatchObject({
      runId: "run-1",
      agentId: "agent-1",
      status: "running",
      startedAt: "2026-04-17T10:00:00.000Z",
      finishedAt: null,
      error: null,
      errorCode: null,
    });
  });

  it("emits agent.run.finished with finishedAt as occurredAt", async () => {
    const { bus, calls } = makeMockBus();
    const finishedAt = new Date("2026-04-17T10:05:00Z");
    emitRunStatusPluginEvent(
      bus,
      buildRun({
        status: "finished",
        finishedAt,
      }),
    );
    await new Promise((r) => setImmediate(r));

    const event = calls[0]!;
    expect(event.eventType).toBe("agent.run.finished");
    expect(event.occurredAt).toBe("2026-04-17T10:05:00.000Z");
    expect((event.payload as { finishedAt: string }).finishedAt).toBe(
      "2026-04-17T10:05:00.000Z",
    );
  });

  it("emits agent.run.failed and carries error / errorCode through the payload", async () => {
    const { bus, calls } = makeMockBus();
    emitRunStatusPluginEvent(
      bus,
      buildRun({
        status: "failed",
        finishedAt: new Date("2026-04-17T10:05:00Z"),
        error: "process exited 1",
        errorCode: "adapter_error",
      }),
    );
    await new Promise((r) => setImmediate(r));

    const event = calls[0]!;
    expect(event.eventType).toBe("agent.run.failed");
    expect(event.payload).toMatchObject({
      error: "process exited 1",
      errorCode: "adapter_error",
    });
  });

  it("emits agent.run.cancelled", async () => {
    const { bus, calls } = makeMockBus();
    emitRunStatusPluginEvent(
      bus,
      buildRun({ status: "cancelled", finishedAt: new Date("2026-04-17T10:05:00Z") }),
    );
    await new Promise((r) => setImmediate(r));

    expect(calls[0]?.eventType).toBe("agent.run.cancelled");
  });

  it("does not emit for intermediate statuses like pending", async () => {
    const { bus, emit } = makeMockBus();
    emitRunStatusPluginEvent(bus, buildRun({ status: "pending" }));
    await new Promise((r) => setImmediate(r));
    expect(emit).not.toHaveBeenCalled();
  });

  it("is a no-op when the bus is null", () => {
    // Explicitly verify fire-and-forget with no bus wired
    expect(() => emitRunStatusPluginEvent(null, buildRun({ status: "running" }))).not.toThrow();
  });

  it("swallows emit rejections without throwing (fire-and-forget)", async () => {
    const emit = vi.fn(async () => {
      throw new Error("bus is down");
    });
    const bus = { emit } as unknown as PluginEventBus;
    // Should not throw synchronously and should not leave an unhandled rejection.
    expect(() =>
      emitRunStatusPluginEvent(bus, buildRun({ status: "running" })),
    ).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
