import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

/**
 * Tests for the opt-in OpenTelemetry bootstrap. The @opentelemetry/* packages
 * are optional peer dependencies and are NOT installed in CI, which is itself
 * part of the contract under test: with the endpoint set but packages absent,
 * the module must warn and settle instead of crashing the server.
 *
 * The module reads OTEL_* env vars at import time, so each test resets the
 * module registry and imports a fresh copy.
 */

const ENDPOINT_ENV = "OTEL_EXPORTER_OTLP_ENDPOINT";
const PROTOCOL_ENV = "OTEL_EXPORTER_OTLP_PROTOCOL";

const originalEndpoint = process.env[ENDPOINT_ENV];
const originalProtocol = process.env[PROTOCOL_ENV];

async function importFreshInstrumentation() {
  vi.resetModules();
  return await import("../instrumentation.js");
}

beforeEach(() => {
  delete process.env[ENDPOINT_ENV];
  delete process.env[PROTOCOL_ENV];
});

afterEach(() => {
  if (originalEndpoint === undefined) delete process.env[ENDPOINT_ENV];
  else process.env[ENDPOINT_ENV] = originalEndpoint;
  if (originalProtocol === undefined) delete process.env[PROTOCOL_ENV];
  else process.env[PROTOCOL_ENV] = originalProtocol;
  vi.restoreAllMocks();
});

describe("resolveProtocol", () => {
  it.each([
    [undefined, "grpc", "@opentelemetry/exporter-trace-otlp-grpc"],
    ["", "grpc", "@opentelemetry/exporter-trace-otlp-grpc"],
    ["grpc", "grpc", "@opentelemetry/exporter-trace-otlp-grpc"],
    ["http/protobuf", "http/protobuf", "@opentelemetry/exporter-trace-otlp-proto"],
    ["http/json", "http/json", "@opentelemetry/exporter-trace-otlp-http"],
    ["HTTP/JSON", "http/json", "@opentelemetry/exporter-trace-otlp-http"],
  ])("maps OTEL_EXPORTER_OTLP_PROTOCOL=%s to %s", async (raw, protocol, packageName) => {
    if (raw === undefined) delete process.env[PROTOCOL_ENV];
    else process.env[PROTOCOL_ENV] = raw;

    const { resolveProtocol } = await importFreshInstrumentation();

    expect(resolveProtocol()).toEqual({ protocol, packageName });
  });

  it("warns and falls back to grpc on an unrecognized protocol", async () => {
    process.env[PROTOCOL_ENV] = "carrier-pigeon";
    // Spy before the import so the assertion holds even if a future change
    // makes the warning fire at module load time instead of on the call.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { resolveProtocol } = await importFreshInstrumentation();

    expect(resolveProtocol().protocol).toBe("grpc");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("carrier-pigeon"));
  });
});

describe("instrumentationReady", () => {
  it("resolves immediately when OTEL_EXPORTER_OTLP_ENDPOINT is unset", async () => {
    const { instrumentationReady } = await importFreshInstrumentation();

    await expect(instrumentationReady).resolves.toBeUndefined();
  });

  it("settles with a diagnostic instead of throwing when the endpoint is set but packages are missing", async () => {
    process.env[ENDPOINT_ENV] = "http://collector:4318";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { instrumentationReady } = await importFreshInstrumentation();

    // Bootstrap must absorb the failed dynamic imports — the server keeps
    // booting without tracing rather than crashing on an opt-in feature.
    await expect(instrumentationReady).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("@opentelemetry/* packages are not installed"),
      expect.anything(),
    );
  });
});

describe("getStartupTracer", () => {
  it("returns a usable tracer-shaped object when OTEL_EXPORTER_OTLP_ENDPOINT is unset", async () => {
    const { getStartupTracer } = await importFreshInstrumentation();

    const tracer = getStartupTracer();

    // The accessor never returns null. The result exposes the span surface the
    // startup seam calls, so the caller needs no null check.
    expect(tracer).not.toBeNull();
    expect(typeof tracer.startSpan).toBe("function");
    // A no-op tracer must open and end a span without throwing.
    expect(() => tracer.startSpan("workspace.resolve").end()).not.toThrow();
  });

  it("loads no OTel SDK package when the endpoint is unset", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { getStartupTracer, instrumentationReady } = await importFreshInstrumentation();

    // The endpoint is unset, so the bootstrap never runs and no SDK package
    // import is attempted; readiness resolves at once.
    await expect(instrumentationReady).resolves.toBeUndefined();

    // The accessor still returns a usable tracer even though no @opentelemetry
    // SDK package is installed. That proves it never imported the SDK: a hard
    // dependency on the SDK would throw here instead.
    const tracer = getStartupTracer();
    expect(typeof tracer.startSpan).toBe("function");
    expect(() => tracer.startSpan("stage.sync").end()).not.toThrow();

    // The bootstrap "packages are not installed" diagnostic must not fire on
    // this path. That message comes only from the endpoint-set bootstrap.
    for (const call of warn.mock.calls) {
      expect(String(call[0])).not.toContain("@opentelemetry/* packages are not installed");
    }
  });
});

describe("shutdownInstrumentation", () => {
  it("is a no-op when tracing is off and idempotent across calls", async () => {
    const { shutdownInstrumentation } = await importFreshInstrumentation();

    const first = shutdownInstrumentation();
    const second = shutdownInstrumentation();

    // Memoized: concurrent callers share one shutdown promise.
    expect(first).toBe(second);
    await expect(first).resolves.toBeUndefined();
  });

  it("resolves after a failed bootstrap instead of hanging", async () => {
    process.env[ENDPOINT_ENV] = "http://collector:4318";
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { shutdownInstrumentation } = await importFreshInstrumentation();

    await expect(shutdownInstrumentation()).resolves.toBeUndefined();
  });
});

// The `@opentelemetry/*` packages are optional. When they are absent,
// `recordProviderPluginSpan` is a no-op by contract, so a native-duration test
// cannot run. Resolve the SDK first and skip the test when it is not installed.
const otelSdk = (() => {
  try {
    const require = createRequire(import.meta.url);
    return {
      api: require("@opentelemetry/api") as typeof import("@opentelemetry/api"),
      sdk: require("@opentelemetry/sdk-trace-base") as typeof import("@opentelemetry/sdk-trace-base"),
    };
  } catch {
    return null;
  }
})();

const hrTimeToMs = (time: [number, number]): number => time[0] * 1000 + time[1] / 1e6;

describe.skipIf(!otelSdk)("recordProviderPluginSpan native duration", () => {
  it("opens the span at the true start time and ends it at the true end time", async () => {
    const { api, sdk } = otelSdk!;
    const exporter = new sdk.InMemorySpanExporter();
    const provider = new sdk.BasicTracerProvider({
      spanProcessors: [new sdk.SimpleSpanProcessor(exporter)],
    });
    api.trace.setGlobalTracerProvider(provider);
    try {
      const { recordProviderPluginSpan } = await import("../instrumentation.js");
      const startTimeMs = Date.now() - 4500;
      const endTimeMs = startTimeMs + 4500;
      recordProviderPluginSpan({
        name: "sandbox.provider.mkdir",
        parent: {
          traceId: "0af7651916cd43dd8448eb211c80319c",
          spanId: "b7ad6b7169203331",
          traceFlags: 1,
        },
        attributes: { provider: "daytona" },
        startTimeMs,
        endTimeMs,
      });
      const finished = exporter.getFinishedSpans();
      expect(finished).toHaveLength(1);
      const span = finished[0]!;
      expect(span.name).toBe("sandbox.provider.mkdir");
      expect(Math.round(hrTimeToMs(span.startTime as [number, number]))).toBe(startTimeMs);
      expect(Math.round(hrTimeToMs(span.endTime as [number, number]))).toBe(endTimeMs);
      // The native width equals the true wall-clock difference, not near zero.
      expect(Math.round(hrTimeToMs(span.duration as [number, number]))).toBe(4500);
    } finally {
      api.trace.disable();
    }
  });

  it("opens and ends the span now when the timestamp pair is absent", async () => {
    const { api, sdk } = otelSdk!;
    const exporter = new sdk.InMemorySpanExporter();
    const provider = new sdk.BasicTracerProvider({
      spanProcessors: [new sdk.SimpleSpanProcessor(exporter)],
    });
    api.trace.setGlobalTracerProvider(provider);
    try {
      const { recordProviderPluginSpan } = await import("../instrumentation.js");
      recordProviderPluginSpan({
        name: "sandbox.provider.pack",
        parent: {
          traceId: "0af7651916cd43dd8448eb211c80319c",
          spanId: "b7ad6b7169203331",
          traceFlags: 1,
        },
        attributes: { provider: "daytona" },
      });
      const finished = exporter.getFinishedSpans();
      expect(finished).toHaveLength(1);
      // The synchronous open-and-end path yields a near-zero native width.
      expect(hrTimeToMs(finished[0]!.duration as [number, number])).toBeLessThan(1000);
    } finally {
      api.trace.disable();
    }
  });
});
