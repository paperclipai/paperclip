import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getStartupTraceContext,
  getStartupTracer,
  resolveProtocol,
} from "./instrumentation.js";

// The span export path selects the OTLP trace-exporter package from the
// `OTEL_EXPORTER_OTLP_PROTOCOL` env var. `resolveProtocol` owns that choice.
// A wrong package name sends spans over the wrong wire protocol, so the
// exporter never reaches the collector.
describe("resolveProtocol", () => {
  const PROTOCOL_ENV = "OTEL_EXPORTER_OTLP_PROTOCOL";
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env[PROTOCOL_ENV];
    delete process.env[PROTOCOL_ENV];
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env[PROTOCOL_ENV];
    } else {
      process.env[PROTOCOL_ENV] = previous;
    }
    vi.restoreAllMocks();
  });

  it("defaults to grpc when the protocol is unset", () => {
    expect(resolveProtocol()).toEqual({
      protocol: "grpc",
      packageName: "@opentelemetry/exporter-trace-otlp-grpc",
    });
  });

  it("defaults to grpc when the protocol is an empty string", () => {
    process.env[PROTOCOL_ENV] = "";
    expect(resolveProtocol()).toEqual({
      protocol: "grpc",
      packageName: "@opentelemetry/exporter-trace-otlp-grpc",
    });
  });

  it("selects the grpc exporter for grpc", () => {
    process.env[PROTOCOL_ENV] = "grpc";
    expect(resolveProtocol()).toEqual({
      protocol: "grpc",
      packageName: "@opentelemetry/exporter-trace-otlp-grpc",
    });
  });

  it("selects the protobuf exporter for http/protobuf", () => {
    process.env[PROTOCOL_ENV] = "http/protobuf";
    expect(resolveProtocol()).toEqual({
      protocol: "http/protobuf",
      packageName: "@opentelemetry/exporter-trace-otlp-proto",
    });
  });

  it("selects the json exporter for http/json", () => {
    process.env[PROTOCOL_ENV] = "http/json";
    expect(resolveProtocol()).toEqual({
      protocol: "http/json",
      packageName: "@opentelemetry/exporter-trace-otlp-http",
    });
  });

  it("normalizes surrounding space and letter case", () => {
    process.env[PROTOCOL_ENV] = "  HTTP/PROTOBUF  ";
    expect(resolveProtocol()).toEqual({
      protocol: "http/protobuf",
      packageName: "@opentelemetry/exporter-trace-otlp-proto",
    });
  });

  it("warns and falls back to grpc for an unknown protocol", () => {
    process.env[PROTOCOL_ENV] = "carrier-pigeon";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(resolveProtocol()).toEqual({
      protocol: "grpc",
      packageName: "@opentelemetry/exporter-trace-otlp-grpc",
    });
    expect(warn).toHaveBeenCalledOnce();
  });
});

// The manual startup spans read their tracer through these accessors. Both
// accessors must return a usable handle and never throw, whether or not
// `@opentelemetry/api` resolves. When the package is absent, the handle is a
// no-op; when it is present, the api returns a real no-op tracer while no SDK
// is registered. The span methods work in both cases.
describe("startup tracer accessors", () => {
  it("returns a usable span from getStartupTracer", () => {
    const tracer = getStartupTracer();
    const span = tracer.startSpan("unit-test");

    expect(() => {
      span.setAttribute("k", "v");
      span.setStatus({ code: 0 });
      span.end();
    }).not.toThrow();
  });

  it("returns a tracer and a parent-context helper from getStartupTraceContext", () => {
    const traceContext = getStartupTraceContext();

    expect(() => traceContext.tracer.startSpan("unit-test").end()).not.toThrow();
    // The helper never throws. It returns a parent token when the api resolves,
    // or `undefined` from the no-op fallback when it does not.
    expect(() => traceContext.contextWithSpan({})).not.toThrow();
  });
});
