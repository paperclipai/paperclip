import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import type { WorkerHostCallContext } from "../../../packages/plugins/sdk/src/protocol.js";
import { SANDBOX_STARTUP_SPAN_ATTRS as A } from "@paperclipai/adapter-utils/acpx-engine/startup-timing";
import {
  buildHostServices,
  clampProviderSpanAttributes,
  parseTraceparent,
} from "../services/plugin-host-services.js";

// Capture every span the host trust boundary hands to the real tracer.
const mockRecordSpan = vi.hoisted(() => vi.fn());

vi.mock("../instrumentation.js", () => ({
  recordProviderPluginSpan: mockRecordSpan,
  traceparentFromContextToken: () => undefined,
}));

function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: vi.fn(), subscribe: vi.fn() };
    },
  } as never;
}

// A well-formed W3C traceparent (the host mints it; the handler validates it).
const VALID_TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

function servicesFor() {
  return buildHostServices({} as never, "plugin-record-id", "daytona", createEventBusStub());
}

function handlersFor(capabilities: readonly string[]) {
  return createHostClientHandlers({
    pluginId: "daytona",
    capabilities: capabilities as never,
    services: servicesFor(),
  });
}

describe("plugin provider span host handler", () => {
  beforeEach(() => {
    mockRecordSpan.mockReset();
  });

  it("records a span with the clamped name and the allowlisted attributes", async () => {
    const services = servicesFor();
    await services.tracer.record(
      {
        name: "pack",
        attributes: {
          [A.provider]: "daytona",
          [A.packWallMs]: 12,
        },
      },
      { traceparent: VALID_TRACEPARENT } as WorkerHostCallContext,
    );

    expect(mockRecordSpan).toHaveBeenCalledTimes(1);
    const call = mockRecordSpan.mock.calls[0]![0] as {
      name: string;
      parent: { traceId: string; spanId: string; traceFlags: number };
      attributes: Record<string, unknown>;
    };
    expect(call.name).toBe("sandbox.provider.pack");
    expect(call.parent).toEqual({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: 1,
    });
    expect(call.attributes[A.provider]).toBe("daytona");
    expect(call.attributes[A.packWallMs]).toBe(12);
  });

  it("drops every forbidden attribute before the span reaches the tracer", async () => {
    const services = servicesFor();
    await services.tracer.record(
      {
        name: "transfer",
        attributes: {
          [A.transferGuardCount]: 2,
          // Forbidden fields that must never ride a span.
          [A.execCommand]: "bash",
          command: "rm -rf /",
          args: "--force",
          stdout: "secret output",
          stderr: "secret error",
          path: "/etc/passwd",
          extra: "leak",
        },
      },
      { traceparent: VALID_TRACEPARENT } as WorkerHostCallContext,
    );

    expect(mockRecordSpan).toHaveBeenCalledTimes(1);
    const attributes = (mockRecordSpan.mock.calls[0]![0] as { attributes: Record<string, unknown> })
      .attributes;
    // Only the allowlisted key survives; every forbidden key is dropped.
    expect(attributes).toEqual({ [A.transferGuardCount]: 2 });
    for (const forbidden of [A.execCommand, "command", "args", "stdout", "stderr", "path", "extra"]) {
      expect(attributes).not.toHaveProperty(forbidden);
    }
  });

  it("drops a status message (it could carry standard-stream text)", async () => {
    const services = servicesFor();
    await services.tracer.record(
      { name: "transfer", status: { code: 2, message: "secret error text" } },
      { traceparent: VALID_TRACEPARENT } as WorkerHostCallContext,
    );
    const call = mockRecordSpan.mock.calls[0]![0] as { status?: { code: number; message?: string } };
    expect(call.status).toEqual({ code: 2 });
    expect(call.status).not.toHaveProperty("message");
  });

  it("clamps an unknown span name to sandbox.provider.other", async () => {
    const services = servicesFor();
    await services.tracer.record(
      { name: "rm -rf / --no-preserve-root" },
      { traceparent: VALID_TRACEPARENT } as WorkerHostCallContext,
    );
    expect((mockRecordSpan.mock.calls[0]![0] as { name: string }).name).toBe(
      "sandbox.provider.other",
    );
  });

  it("admits each per-round-trip span name to sandbox.provider.<name>", async () => {
    const services = servicesFor();
    for (const name of ["mkdir", "guard", "rename", "extract", "provision"]) {
      await services.tracer.record(
        { name },
        { traceparent: VALID_TRACEPARENT } as WorkerHostCallContext,
      );
    }
    const recorded = mockRecordSpan.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(recorded).toEqual([
      "sandbox.provider.mkdir",
      "sandbox.provider.guard",
      "sandbox.provider.rename",
      "sandbox.provider.extract",
      "sandbox.provider.provision",
    ]);
  });

  it("admits the session setup and teardown span names", async () => {
    const services = servicesFor();
    for (const name of ["session.setup", "session.teardown"]) {
      await services.tracer.record(
        { name },
        { traceparent: VALID_TRACEPARENT } as WorkerHostCallContext,
      );
    }
    const recorded = mockRecordSpan.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(recorded).toEqual([
      "sandbox.provider.session.setup",
      "sandbox.provider.session.teardown",
    ]);
  });

  it("forwards a valid start-time and end-time pair to the recorder", async () => {
    const services = servicesFor();
    const startTimeMs = Date.now() - 4500;
    const endTimeMs = startTimeMs + 4500;
    await services.tracer.record(
      { name: "mkdir", startTimeMs, endTimeMs },
      { traceparent: VALID_TRACEPARENT } as WorkerHostCallContext,
    );
    const call = mockRecordSpan.mock.calls[0]![0] as {
      startTimeMs?: number;
      endTimeMs?: number;
    };
    expect(call.startTimeMs).toBe(startTimeMs);
    expect(call.endTimeMs).toBe(endTimeMs);
  });

  it("accepts a pair whose end is a small skew ahead of the host clock", async () => {
    const services = servicesFor();
    // The worker clock leads the host clock by a few seconds. This small skew
    // is within the allowed bound, so the host keeps the native width.
    const startTimeMs = Date.now() + 5000;
    const endTimeMs = startTimeMs + 1000;
    await services.tracer.record(
      { name: "mkdir", startTimeMs, endTimeMs },
      { traceparent: VALID_TRACEPARENT } as WorkerHostCallContext,
    );
    const call = mockRecordSpan.mock.calls[0]![0] as {
      startTimeMs?: number;
      endTimeMs?: number;
    };
    expect(call.startTimeMs).toBe(startTimeMs);
    expect(call.endTimeMs).toBe(endTimeMs);
  });

  it("drops an invalid timestamp pair so the synchronous path runs", async () => {
    const services = servicesFor();
    const now = Date.now();
    const invalidPairs: Array<{ startTimeMs?: unknown; endTimeMs?: unknown; why: string }> = [
      { startTimeMs: now, endTimeMs: now - 1000, why: "reversed order" },
      { startTimeMs: Number.NaN, endTimeMs: now, why: "non-finite start" },
      { startTimeMs: now, endTimeMs: Number.POSITIVE_INFINITY, why: "non-finite end" },
      { startTimeMs: now, endTimeMs: now + 11 * 60 * 1000, why: "over-ceiling duration" },
      { startTimeMs: now - 2 * 60 * 60 * 1000, endTimeMs: now - 2 * 60 * 60 * 1000 + 10, why: "over-age start" },
      { startTimeMs: now, endTimeMs: now + 2 * 60 * 1000, why: "end far in the future" },
      { startTimeMs: now + 5 * 60 * 1000, endTimeMs: now + 5 * 60 * 1000 + 10, why: "start and end in the future" },
    ];
    for (const pair of invalidPairs) {
      mockRecordSpan.mockReset();
      await services.tracer.record(
        { name: "mkdir", startTimeMs: pair.startTimeMs, endTimeMs: pair.endTimeMs } as never,
        { traceparent: VALID_TRACEPARENT } as WorkerHostCallContext,
      );
      // The span still records (the synchronous path), but without a timestamp.
      const call = mockRecordSpan.mock.calls[0]![0] as {
        startTimeMs?: number;
        endTimeMs?: number;
      };
      expect(call.startTimeMs, pair.why).toBeUndefined();
      expect(call.endTimeMs, pair.why).toBeUndefined();
    }
  });

  it("records the synchronous path when the timestamp pair is absent", async () => {
    const services = servicesFor();
    await services.tracer.record(
      { name: "pack" },
      { traceparent: VALID_TRACEPARENT } as WorkerHostCallContext,
    );
    const call = mockRecordSpan.mock.calls[0]![0] as {
      startTimeMs?: number;
      endTimeMs?: number;
    };
    expect(call.startTimeMs).toBeUndefined();
    expect(call.endTimeMs).toBeUndefined();
  });

  it("rejects a malformed traceparent — no span is recorded", async () => {
    const services = servicesFor();
    for (const bad of [
      undefined,
      "not-a-traceparent",
      "00-xyz-b7ad6b7169203331-01",
      "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331", // missing flags
      "00-00000000000000000000000000000000-b7ad6b7169203331-01", // all-zero trace id
    ]) {
      await services.tracer.record(
        { name: "pack" },
        { traceparent: bad } as WorkerHostCallContext,
      );
    }
    expect(mockRecordSpan).not.toHaveBeenCalled();
  });

  it("rejects a span from a plugin that lacks the environment-driver capability", async () => {
    const handlers = handlersFor([]);
    await expect(
      handlers["span.record"](
        { name: "pack" },
        { traceparent: VALID_TRACEPARENT } as WorkerHostCallContext,
      ),
    ).rejects.toThrow(/capabilit/i);
    expect(mockRecordSpan).not.toHaveBeenCalled();
  });

  it("admits a span from a plugin that holds the environment-driver capability", async () => {
    const handlers = handlersFor(["environment.drivers.register"]);
    await handlers["span.record"](
      { name: "pack", attributes: { [A.provider]: "daytona" } },
      { traceparent: VALID_TRACEPARENT } as WorkerHostCallContext,
    );
    expect(mockRecordSpan).toHaveBeenCalledTimes(1);
  });
});

describe("parseTraceparent", () => {
  it("accepts a well-formed traceparent and returns the parts", () => {
    expect(parseTraceparent(VALID_TRACEPARENT)).toEqual({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: 1,
    });
  });

  it("rejects malformed, all-zero, and forbidden-version traceparents", () => {
    expect(parseTraceparent(undefined)).toBeNull();
    expect(parseTraceparent("garbage")).toBeNull();
    expect(parseTraceparent("00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01")).toBeNull();
    expect(parseTraceparent("ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")).toBeNull();
  });
});

describe("clampProviderSpanAttributes", () => {
  it("keeps only allowlisted keys and normalizes the provider family", () => {
    expect(
      clampProviderSpanAttributes({
        [A.provider]: "some-operator-key",
        [A.packWallMs]: 7,
        [A.transferWallMs]: Number.NaN,
        [A.execCommand]: "bash",
      }),
    ).toEqual({
      // An unknown provider key maps to `plugin`, never the raw key.
      [A.provider]: "plugin",
      [A.packWallMs]: 7,
      // A non-finite number yields no attribute; `exec.command` is not allowed.
    });
  });
});
