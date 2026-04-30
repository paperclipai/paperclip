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
  capabilities: ["environment.drivers.register", "api.routes.register"],
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
  // Plugin-local routes mounted at /api/plugins/kkroo.ccrotate/api/*. Each
  // route takes the SSH config in its body so a single plugin install can
  // operate against multiple ccrotate hosts (.32, .33, .34, paperclip pod);
  // the caller resolves which environment to query and forwards its ssh
  // section. The hooks/pools UI panel uses these to render the live state.
  apiRoutes: [
    {
      routeKey: "pools",
      method: "POST",
      path: "/pools",
      auth: "board",
      capability: "api.routes.register",
    },
    {
      routeKey: "switch",
      method: "POST",
      path: "/switch",
      auth: "board",
      capability: "api.routes.register",
    },
    {
      routeKey: "refresh",
      method: "POST",
      path: "/refresh",
      auth: "board",
      capability: "api.routes.register",
    },
  ],
};

export default manifest;
