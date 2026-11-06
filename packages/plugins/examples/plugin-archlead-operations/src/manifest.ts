import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclipai.plugin-archlead-operations";

export const OPERATIONS_JOBS = [
  { jobKey: "inbound-triage", displayName: "Inbound triage" },
  { jobKey: "gmail-sync", displayName: "Gmail sync" },
  { jobKey: "onboarding-sweep", displayName: "Onboarding sweep" },
  { jobKey: "watchdog", displayName: "Operations watchdog" },
  { jobKey: "weekday-outbound", displayName: "Weekday outbound" },
  { jobKey: "seo-research", displayName: "SEO research" },
  { jobKey: "pr-outreach", displayName: "PR outreach" },
  { jobKey: "brief-generation", displayName: "Brief generation" },
] as const;

const secretRefSchema = {
  type: "object",
  format: "secret-ref",
  title: "Paperclip secret reference",
  description: "Select a secret reference. Secret values are resolved only when a webhook arrives.",
  required: ["type", "secretId"],
  properties: {
    type: { const: "secret_ref" },
    secretId: { type: "string", minLength: 1 },
    version: {
      anyOf: [{ type: "integer", minimum: 1 }, { const: "latest" }],
    },
    projectionClass: { type: "string" },
    projectionAllowlistKey: { type: ["string", "null"] },
  },
  additionalProperties: false,
};

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "ArchLead Operations",
  description: "Company-scoped CRM, support, sandbox qualification, and payment-event migration slice.",
  author: "Paperclip",
  categories: ["automation", "ui", "connector"],
  capabilities: [
    "activity.log.write",
    "api.routes.register",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "issues.create",
    "issues.read",
    "issue.interactions.create",
    "issue.interactions.read",
    "jobs.schedule",
    "secrets.read-ref",
    "ui.page.register",
    "webhooks.receive",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      intakeWebhookSecretRef: {
        ...secretRefSchema,
        title: "Signed intake webhook secret",
      },
      cashfreeWebhookSecretRef: {
        ...secretRefSchema,
        title: "Cashfree webhook secret",
      },
      paddleWebhookSecretRef: {
        ...secretRefSchema,
        title: "Paddle webhook secret",
      },
    },
  },
  database: {
    namespaceSlug: "archlead_operations",
    migrationsDir: "migrations",
    coreReadTables: ["companies"],
  },
  apiRoutes: [
    {
      routeKey: "list-records",
      method: "GET",
      path: "/records",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "create-lead",
      method: "POST",
      path: "/leads",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "create-request",
      method: "POST",
      path: "/requests",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "create-client",
      method: "POST",
      path: "/clients",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "create-payment-order",
      method: "POST",
      path: "/payment-orders",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "create-qualification-task",
      method: "POST",
      path: "/qualification-tasks",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "get-qualification-task",
      method: "GET",
      path: "/qualification-tasks/:externalLeadId",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "update-record",
      method: "PATCH",
      path: "/records/:entityType/:externalId",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "convert-request",
      method: "POST",
      path: "/requests/:externalId/client",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
  ],
  jobs: OPERATIONS_JOBS.map(({ jobKey, displayName }) => ({
    jobKey,
    displayName,
    description: "Manual-only migration hook; no integration work is scheduled until it is ported.",
  })),
  webhooks: [
    {
      endpointKey: "intake",
      displayName: "Signed lead and support intake",
      description: "Public lead and support intake. Requires a company-secret HMAC signature.",
    },
    {
      endpointKey: "cashfree-events",
      displayName: "Cashfree payment status events",
      description: "Verifies Cashfree's raw-body signature and matches signed order tags to a Paperclip order.",
    },
    {
      endpointKey: "paddle-events",
      displayName: "Paddle transaction status events",
      description: "Verifies Paddle's timestamped signature and matches signed custom_data to a Paperclip order.",
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: "operations",
        displayName: "ArchLead Operations",
        exportName: "ArchLeadOperationsPage",
        routePath: "archlead-operations",
      },
    ],
  },
};

export default manifest;
