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
