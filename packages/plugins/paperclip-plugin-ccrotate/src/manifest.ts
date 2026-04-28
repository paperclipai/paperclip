import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { CCROTATE_CONFIG_SCHEMA } from "./config.js";

export const PLUGIN_ID = "kkroo.ccrotate";
export const PLUGIN_VERSION = "0.1.0";
export const DRIVER_KEY = "ccrotate";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "ccrotate",
  description:
    "Sandbox provider that runs agents through a ccrotate-managed Claude or Codex account pool over SSH, rotating between accounts at lease acquisition and on rate-limit signals mid-run.",
  author: "kkroo",
  categories: ["automation", "connector"],
  capabilities: ["environment.drivers.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  environmentDrivers: [
    {
      driverKey: DRIVER_KEY,
      kind: "sandbox_provider",
      displayName: "ccrotate (Claude / Codex pool)",
      description:
        "Each lease rotates to a healthy account via ccrotate, executes commands over SSH against the host where ccrotate lives, and re-rotates if rate-limit output is detected mid-run.",
      configSchema: CCROTATE_CONFIG_SCHEMA,
    },
  ],
};

export default manifest;
