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

describe("checkExactPeerVersions", () => {
  it("passes when the installed version matches the declared version exactly", async () => {
    const { checkExactPeerVersions } = await importFreshInstrumentation();
    const require = createRequire(import.meta.url);
    const vitestVersion = (require("vitest/package.json") as { version: string }).version;

    const result = checkExactPeerVersions(["vitest"], { vitest: vitestVersion });

    expect(result).toEqual({ ok: true });
  });

  it("reports a package as missing when it cannot be resolved", async () => {
    const { checkExactPeerVersions } = await importFreshInstrumentation();

    const result = checkExactPeerVersions(["@paperclipai/does-not-exist-anywhere"], {
      "@paperclipai/does-not-exist-anywhere": "1.0.0",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic).toContain("@opentelemetry/* packages are not installed");
      expect(result.diagnostic).toContain("@paperclipai/does-not-exist-anywhere");
    }
  });

  it("reports a package as mismatched when the installed version differs from the declared version", async () => {
    const { checkExactPeerVersions } = await importFreshInstrumentation();
    const require = createRequire(import.meta.url);
    const vitestVersion = (require("vitest/package.json") as { version: string }).version;

    const result = checkExactPeerVersions(["vitest"], {
      vitest: "0.0.0-not-the-installed-version",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic).toContain("a package is installed at an unsupported version");
      expect(result.diagnostic).toContain(`vitest@${vitestVersion}`);
      expect(result.diagnostic).toContain("expected 0.0.0-not-the-installed-version");
    }
  });
});

describe("bootstrapOtel exact-version gate", () => {
  it("does not mention the two exporters OTEL_EXPORTER_OTLP_PROTOCOL did not select", async () => {
    process.env[ENDPOINT_ENV] = "http://collector:4318";
    process.env[PROTOCOL_ENV] = "http/json";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { instrumentationReady } = await importFreshInstrumentation();
    await instrumentationReady;

    // The OTel packages are absent in this test environment, so the gate
    // reports every checked package as missing. It must have checked the
    // selected exporter (http/json → exporter-trace-otlp-http) and skipped
    // the two the protocol did not select.
    const diagnosticCall = warn.mock.calls.find((call) =>
      String(call[0]).includes("@opentelemetry/* packages are not installed"),
    );
    expect(diagnosticCall).toBeDefined();
    const message = String(diagnosticCall![0]);
    expect(message).toContain("@opentelemetry/exporter-trace-otlp-http");
    expect(message).not.toContain("@opentelemetry/exporter-trace-otlp-grpc");
    expect(message).not.toContain("@opentelemetry/exporter-trace-otlp-proto");
  });

  it("emits exactly one diagnostic when the endpoint is set and packages are absent", async () => {
    process.env[ENDPOINT_ENV] = "http://collector:4318";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { instrumentationReady } = await importFreshInstrumentation();
    await instrumentationReady;

    const diagnosticCalls = warn.mock.calls.filter((call) =>
      String(call[0]).includes("@opentelemetry/* packages are not installed"),
    );
    expect(diagnosticCalls).toHaveLength(1);
  });
});

describe("bootstrapOtel post-gate load failure", () => {
  it("logs a load-failure diagnostic, not the missing-package message, when a package passes the gate but its dynamic import fails", async () => {
    process.env[ENDPOINT_ENV] = "http://collector:4318";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Fake the resolution steps the exact-version gate uses, so every checked
    // package reports as installed at its declared version. The dynamic
    // `import(...)` calls in bootstrapOtel are untouched, so they still fail
    // for real — the packages are not actually installed in this test run.
    // That forces the one path the catch block now must describe: a package
    // that passed the gate but failed to load.
    const FAKE_ROOT = "/fake-otel-pkg";
    const require = createRequire(import.meta.url);
    const peerDependencies = (
      require("../../package.json") as { peerDependencies?: Record<string, string> }
    ).peerDependencies ?? {};

    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        existsSync: (path: unknown) =>
          String(path).startsWith(FAKE_ROOT) ? true : actual.existsSync(path as never),
        readFileSync: (path: unknown, options?: unknown) => {
          const asString = String(path);
          if (asString.startsWith(FAKE_ROOT) && asString.endsWith("package.json")) {
            const name = decodeURIComponent(
              asString.slice(FAKE_ROOT.length + 1, -"/package.json".length),
            );
            return JSON.stringify({ name, version: peerDependencies[name] });
          }
          return actual.readFileSync(path as never, options as never);
        },
      };
    });
    vi.doMock("node:module", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:module")>();
      return {
        ...actual,
        createRequire: (...args: Parameters<typeof actual.createRequire>) => {
          const real = actual.createRequire(...args);
          const fake = ((id: string) => real(id)) as typeof real;
          fake.resolve = ((id: string, options?: unknown) =>
            id in peerDependencies
              ? `${FAKE_ROOT}/${encodeURIComponent(id)}/index.js`
              : real.resolve(id, options as never)) as typeof real.resolve;
          return fake;
        },
      };
    });

    try {
      const { instrumentationReady } = await import("../instrumentation.js");
      await instrumentationReady;
    } finally {
      vi.doUnmock("node:fs");
      vi.doUnmock("node:module");
    }

    for (const call of warn.mock.calls) {
      expect(String(call[0])).not.toContain("packages are not installed");
      expect(String(call[0])).not.toContain("Install @opentelemetry/sdk-node");
    }
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("passed the version check"),
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
        name: "sandbox.daytona.ensureDirectory",
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
      expect(span.name).toBe("sandbox.daytona.ensureDirectory");
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
        name: "sandbox.daytona.pack",
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
