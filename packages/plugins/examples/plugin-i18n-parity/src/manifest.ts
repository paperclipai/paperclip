import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "ocho.i18n-parity",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "i18n Parity Scanner",
  description:
    "Scans localized HTML pages and scores translation parity per surface. Surfaces still-English content across all supported locales.",
  author: "Ocho",
  categories: ["automation", "connector"],
  capabilities: [
    "agent.tools.register",
    "activity.log.write",
    "ui.sidebar.register",
    "ui.page.register",
    "ui.dashboardWidget.register",
    "companies.read",
    "issues.create",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      repoPath: {
        type: "string",
        description:
          "Absolute path to the sudokuaday.com repo root to scan.",
      },
      localeConfigFile: {
        type: "string",
        description:
          "Path to the locale config JSON file, relative to repoPath. Defaults to 'config.locales.json'.",
      },
      minScore: {
        type: "number",
        description:
          "Minimum weighted parity score (0–1) below which a page is flagged. Defaults to 0.7.",
      },
      surfaceWeights: {
        type: "object",
        description:
          "Map of surface name to weight multiplier. Surfaces: meta, nav, hero, main, cta, footer, embeds.",
        additionalProperties: { type: "number" },
      },
      excludePatterns: {
        type: "array",
        items: { type: "string" },
        description:
          "Glob patterns (relative to repoPath) to exclude from scanning.",
      },
    },
    required: ["repoPath"],
  },
  tools: [
    {
      name: "run-scan",
      displayName: "Run i18n Parity Scan",
      description:
        "Scans all localized HTML pages and returns parity scores. Accepts optional locale filter and page limit.",
      parametersSchema: {
        type: "object",
        properties: {
          locale: {
            type: "string",
            description:
              "Locale code to scan (e.g. 'ja'). Omit to scan all non-English locales.",
          },
          pageLimit: {
            type: "number",
            description: "Maximum number of pages to scan per locale.",
          },
        },
      },
    },
    {
      name: "get-report",
      displayName: "Get Parity Report",
      description:
        "Returns the full parity report (all locales, all pages) from the most recent scan.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get-summary",
      displayName: "Get Parity Summary",
      description:
        "Returns a per-locale aggregate summary from the most recent scan, sorted by score ascending.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get-page-detail",
      displayName: "Get Page Parity Detail",
      description:
        "Returns per-surface detail for a specific locale+path combination.",
      parametersSchema: {
        type: "object",
        properties: {
          locale: { type: "string", description: "Locale code, e.g. 'ja'." },
          path: {
            type: "string",
            description: "Page path relative to locale root, e.g. 'index.html'.",
          },
        },
        required: ["locale", "path"],
      },
    },
    {
      name: "create-tickets",
      displayName: "Create Parity Tickets",
      description:
        "Creates Paperclip issues for pages that fall below the minScore threshold from the most recent scan.",
      parametersSchema: {
        type: "object",
        properties: {
          minScore: {
            type: "number",
            description:
              "Override threshold (0–1). Defaults to plugin config minScore.",
          },
          dryRun: {
            type: "boolean",
            description:
              "If true, returns planned ticket list without creating issues.",
          },
        },
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "sidebar",
        id: "i18n-parity-sidebar",
        displayName: "i18n Parity",
        exportName: "I18nParitySidebar",
      },
      {
        type: "page",
        id: "i18n-parity-page",
        displayName: "i18n Parity Report",
        routePath: "i18n-parity",
        exportName: "I18nParityPage",
      },
      {
        type: "dashboardWidget",
        id: "i18n-parity-widget",
        displayName: "i18n Parity Snapshot",
        exportName: "I18nParityWidget",
      },
    ],
  },
};

export default manifest;
