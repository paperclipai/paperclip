import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.plugin-ollama",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Ollama",
  description:
    "Companion plugin for the Ollama local adapter. Settings page with Test Connection and mandatory model-license gate, dashboard widget with equivalent-hosted-cost math, and a 5-minute health job.",
  author: "Paperclip",
  categories: ["connector", "ui"],
  capabilities: [
    "instance.settings.register",
    "plugin.state.read",
    "plugin.state.write",
    "jobs.schedule",
    "http.outbound",
    "secrets.read-ref",
    "events.subscribe",
    "ui.page.register",
    "ui.dashboardWidget.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      baseUrl: {
        type: "string",
        title: "Ollama Base URL",
        description: "Base URL of the Ollama HTTP server (e.g. http://127.0.0.1:11434).",
        default: "http://127.0.0.1:11434",
      },
      referenceHostedModel: {
        type: "string",
        title: "Reference hosted model (for equivalent-cost math)",
        description:
          "Single hosted model whose public $/token price is used to compute the dashboard widget's equivalent-hosted-cost figure. Change only if you want a different baseline.",
        default: "gpt-4o-mini",
      },
      referenceInputCostPerMTok: {
        type: "number",
        title: "Reference input cost ($ / 1M tokens)",
        default: 0.15,
      },
      referenceOutputCostPerMTok: {
        type: "number",
        title: "Reference output cost ($ / 1M tokens)",
        default: 0.6,
      },
      acknowledgedLicenses: {
        type: "array",
        title: "Acknowledged model licenses",
        description:
          "Model families whose license has been reviewed and acknowledged by an operator. The adapter MUST NOT be invoked for a model until its family appears here.",
        items: { type: "string" },
        default: [],
      },
    },
    required: ["baseUrl"],
  },
  jobs: [
    {
      jobKey: "ollama-health",
      displayName: "Ollama health probe",
      description:
        "Polls Ollama GET /api/tags every 5 minutes and caches the result for the dashboard widget.",
      schedule: "*/5 * * * *",
    },
  ],
  ui: {
    slots: [
      {
        type: "settingsPage",
        id: "ollama-settings",
        displayName: "Ollama",
        exportName: "SettingsPage",
      },
      {
        type: "dashboardWidget",
        id: "ollama-health-widget",
        displayName: "Ollama",
        exportName: "DashboardWidget",
      },
    ],
  },
};

export default manifest;
