import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_SEVERITY_TO_PRIORITY,
  PLUGIN_ID,
  PLUGIN_VERSION,
  WEBHOOK_KEYS,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Alertmanager Webhook Receiver",
  description:
    "Receives Alertmanager v2 webhooks and converts firing alerts into Paperclip issues with the correct assignee, priority, and metadata. Resolves issues when alerts clear.",
  author: "blockcast-platform",
  categories: ["connector", "automation"],
  capabilities: [
    // Issue lifecycle
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.create",
    // Owner mapping
    "users.read",
    // State (dedup by fingerprint, owner-by-email cache)
    "plugin.state.read",
    "plugin.state.write",
    // Cross-plugin notification fan-out
    "events.emit",
    // Operator-visible signal
    "metrics.write",
    "activity.log.write",
    // Secret-ref resolution for the bearer token
    "secrets.read-ref",
    // Webhook entrypoint (the plugin is webhook-driven)
    "webhooks.receive",
    "instance.settings.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      defaultCompanyId: {
        type: "string",
        title: "Default company id",
        description:
          "Company that receives alerts when no company-routing label is present.",
      },
      webhookTokenRef: {
        type: "string",
        format: "secret-ref",
        title: "Webhook bearer token (secret reference)",
        description:
          "Static bearer token Alertmanager sends in the Authorization header. Strongly recommended; without it the webhook endpoint is unauthenticated.",
      },
      webhookToken: {
        type: "string",
        title: "Webhook bearer token (inline, dev only)",
        description:
          "Inline bearer token — only for local development. Use webhookTokenRef in production.",
      },
      acceptOnlyLabels: {
        type: "object",
        title: "Accept-only label filter",
        description:
          "If set, only alerts whose labels match all of these key=value pairs are accepted. Use to scope a shared-tenancy AM cluster.",
        additionalProperties: { type: "string" },
      },
      severityToPriority: {
        type: "object",
        title: "severity → priority map",
        description:
          "Map from Alertmanager severity to Paperclip issue priority.",
        default: DEFAULT_SEVERITY_TO_PRIORITY,
        additionalProperties: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
        },
      },
      autoCloseOnResolve: {
        type: "boolean",
        title: "Auto-close issue when alert resolves",
        default: true,
        description:
          "Defaults to true. If true or omitted, transitions the issue to status=cancelled when AM sends status=resolved. If false, posts a 'resolved at <ts>' comment and leaves status alone.",
      },
      ownerMap: {
        type: "object",
        title: "Owner map (label-key → value → email)",
        description:
          "Per-instance config. e.g. { team: { 'platform': 'alice@blockcast.net' } }. Resolution chain documented in the plugin spec §7.7.",
      },
      issueRouteMap: {
        type: "object",
        title: "Issue route map (label-key → value → issue fields)",
        description:
          "Per-instance config. e.g. { class: { physical_infra_bmc: { projectId, goalId, assigneeAgentId, status: 'todo' } } }. Shipped defaults route Blockcast physical-infra alerts into the physical-infra project queue.",
        additionalProperties: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              projectId: { type: "string" },
              goalId: { type: "string" },
              status: {
                type: "string",
                enum: [
                  "backlog",
                  "todo",
                  "in_progress",
                  "in_review",
                  "done",
                  "blocked",
                  "cancelled",
                ],
              },
              assigneeAgentId: { type: "string" },
              assigneeUserId: { type: "string" },
            },
            additionalProperties: false,
          },
        },
      },
    },
    // No fields are schema-required: the bootstrap auto-config endpoint
    // posts a partial config (e.g. only webhookTokenRef) and the worker
    // tolerates a missing defaultCompanyId — it warns at setup() and
    // rejects per-alert in webhook-handler.ts. Forcing defaultCompanyId
    // here previously broke fresh deploys until an operator wrote it
    // by hand.
    required: [],
  },
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.alertmanager,
      displayName: "Alertmanager v2 webhook",
      description:
        "Alertmanager `webhook_configs` target. Accepts POST with the AM v2 JSON payload. Authenticates via static bearer token (Authorization: Bearer <token>).",
    },
  ],
  // No tools registered for V1 — pure event/webhook plugin.
  tools: [],
};

export default manifest;
