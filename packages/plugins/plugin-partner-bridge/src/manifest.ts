import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclipai.plugin-partner-bridge";
export const DEFAULT_COUCH_DB = "partner_bridge";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Partner Bridge",
  description: "Inter-partnership channel bridge between Paperclip companies.",
  author: "Oleg",
  categories: ["automation"],
  capabilities: [
    "http.outbound",
    "secrets.read-ref",
    "companies.read",
    "jobs.schedule",
    "activity.log.write",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  instanceConfigSchema: {
    type: "object",
    properties: {
      paperclipBaseUrl: { type: "string", description: "Local Paperclip API base (e.g. http://127.0.0.1:3100)" },
      paperclipToken:   { type: "string", description: "Optional Bearer token for the Paperclip API" },
      couchUrl:         { type: "string", description: "CouchDB base URL (e.g. http://127.0.0.1:5984)" },
      couchDb:          { type: "string", description: "CouchDB database name (default: partner_bridge)" },
      couchUser:        { type: "string", description: "CouchDB username" },
      couchPassword:    { type: "string", description: "CouchDB password" },
      hermesBaseUrl:    { type: "string", description: "Hermes connector base URL (Telegram/email transport)" },
      hermesToken:      { type: "string", description: "Bearer token the plugin sends to Hermes" },
      inboundSecret:    { type: "string", description: "Shared secret Hermes echoes in inbound payloads (auth)" },
      links:            { type: "string", description: "JSON array of LinkConfig objects" },
    },
  },
  jobs: [
    { jobKey: "bridge-sync", displayName: "Bridge sync", description: "Detect + mirror new channel items across linked companies.", schedule: "*/15 * * * *" },
  ],
};

export default manifest;
