import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { INSTANCE_CONFIG_SCHEMA } from "./config.js";

export const PLUGIN_ID = "paperclip.ntfy-notifier";
export const PLUGIN_VERSION = "0.2.2";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "ntfy Decision Notifier",
  description:
    "Sends a minimal ntfy push (title \"Paperclip decision <issue>\", tag \"paperclip\", body \"A decision is waiting: <issue>\" plus a link) when an approval, a person-addressed question, a board decision or blocked work needing board attention is waiting.",
  author: "Paperclip",
  categories: ["connector", "automation"],
  capabilities: [
    "events.subscribe",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "issues.read",
    "issue.interactions.read",
    "companies.read",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: INSTANCE_CONFIG_SCHEMA as unknown as PaperclipPluginManifestV1["instanceConfigSchema"],
};

export default manifest;
