import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
