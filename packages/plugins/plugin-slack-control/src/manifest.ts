import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const secret = {
  type: "object", additionalProperties: false, required: ["type", "secretId"],
  properties: { type: { const: "secret_ref" }, secretId: { type: "string", format: "uuid" }, version: { type: "integer", minimum: 1 } },
};
const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.plugin-slack-control", apiVersion: 1, version: "0.1.0",
  displayName: "Slack Control", description: "Explicit private-message commands for configured Paperclip projects.",
  author: "Community", categories: ["automation", "connector"],
  capabilities: [
    "api.routes.register", "database.namespace.migrate", "database.namespace.read", "database.namespace.write",
    "access.members.read", "projects.read", "agents.read", "issues.read", "issues.create", "issues.wakeup",
    "issue.comments.read", "issue.comments.create", "issue.comments.create_human_attributed", "secrets.read-ref", "http.outbound",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  database: { namespaceSlug: "slack_control", migrationsDir: "migrations", coreReadTables: ["companies"] },
  apiRoutes: [{ routeKey: "status", method: "GET", path: "/status", auth: "board", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } }],
  instanceConfigSchema: {
    type: "object", additionalProperties: false,
    properties: {
      enabled: { type: "boolean", default: false },
      workspaceId: { type: "string", pattern: "^T[A-Z0-9]{2,32}$" }, appToken: secret, botToken: secret,
      users: { type: "array", minItems: 1, maxItems: 10, items: {
        type: "object", additionalProperties: false, required: ["slackUserId", "boardUserId"],
        properties: { slackUserId: { type: "string", pattern: "^[UW][A-Z0-9]{2,32}$" }, boardUserId: { type: "string", minLength: 1, maxLength: 128 } },
      } },
      projects: { type: "array", minItems: 1, maxItems: 10, items: {
        type: "object", additionalProperties: false, required: ["alias", "projectId", "agentId"],
        properties: { alias: { type: "string", pattern: "^[a-z][a-z0-9-]{0,31}$" }, projectId: { type: "string", format: "uuid" }, agentId: { type: "string", format: "uuid" } },
      } },
    },
    allOf: [{ if: { properties: { enabled: { const: true } }, required: ["enabled"] }, then: { required: ["workspaceId", "appToken", "botToken", "users", "projects"] } }],
  },
};
export default manifest;
