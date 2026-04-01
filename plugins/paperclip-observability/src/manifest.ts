import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG } from "./config.js";
import { JOB_KEYS, PLUGIN_ID, PLUGIN_VERSION } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Observability",
  description:
    "OpenTelemetry-based observability for Paperclip — metrics, traces, and structured event telemetry for agents, runs, issues, and costs.",
  author: "IsItObservable",
  categories: ["automation", "connector"],
  capabilities: [
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "jobs.schedule",
    "agents.read",
    "issues.read",
    "companies.read",
    "projects.read",
    "goals.read",
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
        description: "OTLP HTTP endpoint for the OpenTelemetry Collector.",
        default: DEFAULT_CONFIG.otlpEndpoint,
      },
      serviceName: {
        type: "string",
        title: "Service Name",
        description: "OTel service.name resource attribute.",
        default: DEFAULT_CONFIG.serviceName,
      },
      serviceVersion: {
        type: "string",
        title: "Service Version",
        description: "OTel service.version resource attribute.",
        default: DEFAULT_CONFIG.serviceVersion,
      },
      exportIntervalMs: {
        type: "number",
        title: "Metric Export Interval (ms)",
        description: "How often metrics are flushed to the collector.",
        default: DEFAULT_CONFIG.exportIntervalMs,
      },
      enableTracing: {
        type: "boolean",
        title: "Enable Tracing",
        description:
          "Collect distributed traces for agent runs and issue lifecycle.",
        default: DEFAULT_CONFIG.enableTracing,
      },
      enableMetrics: {
        type: "boolean",
        title: "Enable Metrics",
        description:
          "Collect counters and histograms for agents, tokens, and costs.",
        default: DEFAULT_CONFIG.enableMetrics,
      },
      resourceAttributes: {
        type: "object",
        title: "Resource Attributes",
        description:
          "Extra key-value pairs added to the OTel resource attributes.",
        default: DEFAULT_CONFIG.resourceAttributes,
      },
    },
  },
  jobs: [
    {
      jobKey: JOB_KEYS.collectMetrics,
      displayName: "Collect Metrics",
      description: "Collect gauge metrics from the Paperclip API.",
      schedule: "* * * * *",
    },
  ],
};

export default manifest;
