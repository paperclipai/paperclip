import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.builder-sample-example";
const PLUGIN_VERSION = "0.1.0";

/**
 * Reference plugin that contributes one tool to the **Builder** surface in
 * addition to the agent surface (Phase 3 of the Company AI Builder plan).
 *
 * The single tool, `current_time`, returns the host server's current time.
 * Trivial behaviour — the point is to demonstrate the `surfaces: ["builder"]`
 * declaration and how a plugin tool is bridged into the Builder catalog.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Builder Sample (Example)",
  description: "Reference plugin demonstrating a Builder-surface tool contribution.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["agent.tools.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  tools: [
    {
      name: "current_time",
      displayName: "Get current time",
      description:
        "Return the host server's current time (ISO-8601). Use this when the user asks 'what time is it?' or needs an absolute reference time.",
      parametersSchema: {
        type: "object",
        properties: {
          timezone: {
            type: "string",
            description: "Optional IANA timezone (e.g. 'UTC', 'America/Los_Angeles').",
          },
        },
        additionalProperties: false,
      },
      // Surface this tool in BOTH places: agents (default behaviour) and
      // the Company AI Builder copilot.
      surfaces: ["agent", "builder"],
    },
  ],
};

export default manifest;
