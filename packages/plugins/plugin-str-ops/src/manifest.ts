import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclipai.plugin-str-ops";
// Kept as the default CouchDB database name; no SDK Postgres namespace used.
export const DB_NAMESPACE_SLUG = "str_ops";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "STR Conciergerie Ops",
  description: "Short-term-rental domain engine: bookings, guests, owners.",
  author: "Oleg",
  categories: ["automation"],
  capabilities: [
    "http.outbound",
    "secrets.read-ref",
    "companies.read",
    "jobs.schedule",
    "agent.tools.register",
    "activity.log.write",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  // No `database` block — records live in CouchDB (reached via ctx.http), not the
  // SDK Postgres namespace. DB_NAMESPACE_SLUG is kept only as the default Couch db name.
  jobs: [
    { jobKey: "channel-poll", displayName: "Channel poll (mock)", description: "Ingest new bookings from the mock channel provider.", schedule: "*/15 * * * *" },
  ],
  tools: [
    { name: "list_properties", displayName: "List properties", description: "List STR properties for the company.", parametersSchema: { type: "object", properties: { companyId: { type: "string" } } } },
    { name: "get_owner", displayName: "Get owner", description: "Fetch an owner by id.", parametersSchema: { type: "object", properties: { companyId: { type: "string" }, ownerId: { type: "string" } }, required: ["ownerId"] } },
    { name: "list_bookings", displayName: "List bookings", description: "List bookings, optionally by property.", parametersSchema: { type: "object", properties: { companyId: { type: "string" }, propertyId: { type: "string" } } } },
    { name: "check_availability", displayName: "Check availability", description: "Is a property free for a date range?", parametersSchema: { type: "object", properties: { companyId: { type: "string" }, propertyId: { type: "string" }, checkIn: { type: "string" }, checkOut: { type: "string" } }, required: ["propertyId", "checkIn", "checkOut"] } },
    { name: "upsert_booking", displayName: "Upsert booking", description: "Create a confirmed booking after an availability check.", parametersSchema: { type: "object", properties: { companyId: { type: "string" }, propertyId: { type: "string" }, channel: { type: "string" }, externalRef: { type: "string" }, checkIn: { type: "string" }, checkOut: { type: "string" }, guestName: { type: "string" }, guestContact: { type: "string" }, guestLocale: { type: "string" }, grossCents: { type: "number" }, feesCents: { type: "number" } }, required: ["propertyId", "channel", "externalRef", "checkIn", "checkOut", "guestName", "guestContact"] } },
  ],
};

export default manifest;
