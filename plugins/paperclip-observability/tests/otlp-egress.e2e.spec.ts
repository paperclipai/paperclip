/**
 * OTLP egress E2E — docker-free.
 *
 * Stands up an in-process OTLP/HTTP receiver (the stand-in for the
 * otel-collector's `otlp` receiver on :4318) and drives the plugin's real
 * OTel SDK so that a span, a metric, and a log are actually exported over
 * OTLP/proto. Proves the plugin → Collector contract end-to-end without
 * requiring docker or a running server. The collector→Dynatrace leg is a
 * standard OTLP passthrough validated separately via the collector config.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { SpanKind, trace } from "@opentelemetry/api";
import { initOTel, type OTelHandle } from "../src/otel-setup.js";

interface CapturedRequest {
  path: string;
  contentType: string | undefined;
  byteLength: number;
  bodyText: string;
}

describe("OTLP egress E2E (plugin → collector receiver)", () => {
  let server: http.Server;
  let port: number;
  let captured: CapturedRequest[];
  let handle: OTelHandle | null;

  beforeEach(async () => {
    captured = [];
    handle = null;
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        captured.push({
          path: req.url ?? "",
          contentType: req.headers["content-type"],
          byteLength: body.length,
          // OTLP/proto encodes attribute + resource keys as UTF-8 strings, so
          // a latin1 view of the payload lets us sanity-check semconv markers.
          bodyText: body.toString("latin1"),
        });
        res.writeHead(200, { "content-type": "application/x-protobuf" });
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    if (handle) await handle.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("exports a span, a metric, and a log over OTLP/proto", async () => {
    handle = initOTel({
      otlpEndpoint: `http://127.0.0.1:${port}`,
      serviceName: "paperclip-e2e",
      serviceVersion: "0.0.0-e2e",
      exportIntervalMs: 200,
      enableTracing: true,
      enableMetrics: true,
      enableLogs: true,
      resourceAttributes: { "deployment.environment": "e2e" },
    });

    // --- Trace: parent execution span + a child linked back to it (the
    //     ↧ jump-to-source span-link contract) ---
    const parent = handle.tracer.startSpan("paperclip.agent.run", {
      kind: SpanKind.INTERNAL,
      attributes: { "paperclip.agent.id": "agent-e2e" },
    });
    const child = handle.tracer.startSpan("paperclip.issue.comment", {
      kind: SpanKind.INTERNAL,
      attributes: { "paperclip.issue.identifier": "ISI-1222" },
      links: [{ context: parent.spanContext() }],
    });
    child.end();
    parent.end();

    // --- Metric ---
    handle.meter
      .createCounter("paperclip.events.processed")
      .add(1, { "paperclip.event.type": "agent.run.finished" });

    // --- Log ---
    expect(handle.otelLogger).not.toBeNull();
    handle.otelLogger?.emit({
      body: "e2e structured log",
      attributes: { "paperclip.plugin.test": "otlp-egress" },
    });

    // shutdown() force-flushes spans (batch), metrics (periodic reader), and
    // logs (simple processor) to the receiver.
    await handle.shutdown();
    handle = null;

    const pathsHit = new Set(captured.map((c) => c.path));
    expect(pathsHit.has("/v1/traces")).toBe(true);
    expect(pathsHit.has("/v1/metrics")).toBe(true);
    expect(pathsHit.has("/v1/logs")).toBe(true);

    for (const req of captured) {
      expect(req.contentType).toBe("application/x-protobuf");
      expect(req.byteLength).toBeGreaterThan(0);
    }

    // Resource + semconv attributes must be serialized into the payloads.
    const traceReq = captured.find((c) => c.path === "/v1/traces");
    expect(traceReq?.bodyText).toContain("paperclip");
    expect(traceReq?.bodyText).toContain("paperclip-e2e");
    const metricReq = captured.find((c) => c.path === "/v1/metrics");
    expect(metricReq?.bodyText).toContain("paperclip.events.processed");
    const logReq = captured.find((c) => c.path === "/v1/logs");
    expect(logReq?.bodyText).toContain("e2e structured log");
  });
});
