import type { PaperclipPluginManifestV1, PluginCapability } from "@paperclipai/plugin-sdk";
import { CHECKOUT_PAGE_ROUTE, PLUGIN_ID, SWEEP_JOB_KEY, WEBHOOK_ENDPOINT_KEY } from "./constants.js";

const capabilities: PluginCapability[] = [
  "companies.read",
  "access.members.read",
  "costs.read",
  "company.standing.write",
  "database.namespace.read",
  "database.namespace.write",
  "database.namespace.migrate",
  "plugin.state.read",
  "plugin.state.write",
  "events.subscribe",
  "jobs.schedule",
  "webhooks.receive",
  "api.routes.register",
  "http.outbound",
  "activity.log.write",
  "instance.settings.register",
  "ui.page.register",
];

/**
 * `companyEnablement` with `locked: true` + `default: "on"` means a company
 * can never dodge billing by disabling the plugin
 * (2026-07-18-settings-visibility-and-plugin-enablement-design.md §4.2).
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Billing",
  description:
    "Flat monthly subscription billing per company with configurable trials, a fully functional stub payment provider, and run-blocking enforcement via company standing.",
  author: "Paperclip",
  categories: ["automation", "ui"],
  capabilities,
  companyEnablement: { default: "on", locked: true },
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  database: {
    namespaceSlug: "billing",
    migrationsDir: "migrations",
    coreReadTables: ["companies"],
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      currency: {
        type: "string",
        title: "Currency (ISO code)",
        default: "EUR",
        minLength: 3,
        maxLength: 3,
      },
      defaultMonthlyPriceCents: {
        type: "integer",
        title: "Default monthly price (cents)",
        default: 4900,
        minimum: 0,
      },
      trialDays: {
        type: "integer",
        title: "Trial length (days)",
        default: 7,
        minimum: 0,
      },
      graceDays: {
        type: "integer",
        title: "Grace period (days)",
        description: "Aligned with provider dunning windows.",
        default: 7,
        minimum: 0,
      },
      trialPolicy: {
        type: "string",
        title: "Trial policy",
        enum: ["first-company-per-owner", "every-company", "none"],
        default: "first-company-per-owner",
      },
      provider: {
        type: "string",
        title: "Payment provider",
        enum: ["stub"],
        default: "stub",
      },
      instanceBaseUrl: {
        type: "string",
        title: "Instance base URL",
        description:
          "Base URL the stub provider uses to POST signed events to this plugin's own webhook endpoint. Provider secrets for real providers resolve via secret refs, never raw config.",
        default: "http://127.0.0.1:3100",
        "x-paperclip-advanced": true,
        "x-paperclip-group": "Stub provider",
      },
    },
  },
  jobs: [
    {
      jobKey: SWEEP_JOB_KEY,
      displayName: "Billing sweep",
      description:
        "Daily reconciliation: creates missing subscription rows, applies time-based transitions, reconciles company standing, cancels subscriptions of deleted companies, replays unapplied ledger events, and delivers due stub-provider events.",
      schedule: "0 4 * * *",
    },
  ],
  webhooks: [
    {
      endpointKey: WEBHOOK_ENDPOINT_KEY,
      displayName: "Billing provider events",
      description:
        "Signed billing provider events (stub provider in v1). Signature-verified in the worker; unverifiable deliveries change no state.",
    },
  ],
  apiRoutes: [
    { routeKey: "creation-summary", method: "GET", path: "/creation-summary", auth: "board", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: "summary", method: "GET", path: "/summary", auth: "board", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: "create-checkout", method: "POST", path: "/checkout", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "resolve-checkout", method: "POST", path: "/checkout/resolve", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "one-click", method: "POST", path: "/subscribe/one-click", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "cancel", method: "POST", path: "/cancel", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "resume", method: "POST", path: "/resume", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "portal", method: "POST", path: "/portal", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
  ],
  ui: {
    slots: [
      {
        type: "companySettingsPage",
        id: "billing-company-page",
        displayName: "Billing",
        exportName: "BillingPage",
        routePath: "billing",
      },
      {
        type: "settingsPage",
        id: "billing-admin-page",
        displayName: "Billing",
        exportName: "BillingAdminPage",
      },
      {
        type: "page",
        id: "billing-checkout-page",
        displayName: "Checkout",
        exportName: "StubCheckoutPage",
        routePath: CHECKOUT_PAGE_ROUTE,
      },
    ],
  },
};

export default manifest;
