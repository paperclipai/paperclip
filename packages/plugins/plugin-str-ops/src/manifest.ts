import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclipai.plugin-str-ops";
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
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "companies.read",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  database: {
    namespaceSlug: DB_NAMESPACE_SLUG,
    migrationsDir: "migrations",
    coreReadTables: ["companies"],
  },
};

export default manifest;
