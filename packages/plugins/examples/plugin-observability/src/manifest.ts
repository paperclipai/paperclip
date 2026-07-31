import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_CONFIG,
  JOB_KEYS,
  PLUGIN_ID,
  PLUGIN_VERSION,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Observability",
  description:
    "OpenTelemetry-based observability for Paperclip — metrics, traces, and structured event telemetry for agents, runs, issues, and costs.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [
    // Read domain data to enrich telemetry
    "companies.read",
    "projects.read",
    "issues.read",
    "agents.read",
    "goals.read",

    // Plugin runtime
    "events.subscribe",
    "events.emit",
    "jobs.schedule",
    "plugin.state.read",
    "plugin.state.write",
    "metrics.write",
    "activity.log.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      otlpEndpoint: {
        type: "string",
        title: "OTLP Endpoint",
        description: "URL of the OpenTelemetry Collector (HTTP or gRPC).",
        default: DEFAULT_CONFIG.otlpEndpoint,
      },
      otlpProtocol: {
        type: "string",
        title: "OTLP Protocol",
        enum: ["http/protobuf", "grpc"],
        default: DEFAULT_CONFIG.otlpProtocol,
      },
      serviceName: {
        type: "string",
        title: "Service Name",
        description: "Logical service name reported in OTel resource attributes.",
        default: DEFAULT_CONFIG.serviceName,
      },
      metricExportIntervalMs: {
        type: "number",
        title: "Metric Export Interval (ms)",
        description: "How often metrics are flushed to the collector.",
        default: DEFAULT_CONFIG.metricExportIntervalMs,
      },
      traceExportTimeoutMs: {
        type: "number",
        title: "Trace Export Timeout (ms)",
        default: DEFAULT_CONFIG.traceExportTimeoutMs,
      },
      enableTracing: {
        type: "boolean",
        title: "Enable Tracing",
        description: "Collect distributed traces for agent runs, issue lifecycle, etc.",
        default: DEFAULT_CONFIG.enableTracing,
      },
      enableMetrics: {
        type: "boolean",
        title: "Enable Metrics",
        description: "Collect counters and histograms for agents, tokens, costs, etc.",
        default: DEFAULT_CONFIG.enableMetrics,
      },
      enableLogs: {
        type: "boolean",
        title: "Enable Log Export",
        description: "Export structured logs via OTel (experimental).",
        default: DEFAULT_CONFIG.enableLogs,
      },
      resourceAttributes: {
        type: "object",
        title: "Resource Attributes",
        description: "Additional key-value pairs added to the OTel resource.",
        default: DEFAULT_CONFIG.resourceAttributes,
      },
    },
  },
  jobs: [
    {
      jobKey: JOB_KEYS.metricsFlush,
      displayName: "OTel Metrics Flush",
      description:
        "Periodic job that forces an OTel metric export and records telemetry pipeline health.",
      schedule: "*/5 * * * *",
    },
  ],
};

export default manifest;
