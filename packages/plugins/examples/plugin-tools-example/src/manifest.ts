import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.tools-example";
const PLUGIN_VERSION = "0.1.0";

/**
 * Manifest for the Tools Example plugin.
 * Declares two agent tools: calculator and weather-lookup.
 * Tools are available to all agents in companies where this plugin is enabled.
 *
 * @see PLUGIN_SPEC.md §11 — Agent Tools
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Tools Example",
  description:
    "Example plugin that adds agent tools (calculator, weather lookup) that all agents can use.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["agent.tools.register", "activity.log.write"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  tools: [
    {
      name: "calculator",
      displayName: "Calculator",
      description:
        "Performs basic arithmetic: add, subtract, multiply, or divide two numbers. Use when an agent needs to compute a numeric result.",
      parametersSchema: {
        type: "object",
        required: ["a", "b", "operation"],
        properties: {
          a: { type: "number", description: "First operand" },
          b: { type: "number", description: "Second operand" },
          operation: {
            type: "string",
            enum: ["add", "subtract", "multiply", "divide"],
            description: "The arithmetic operation to perform",
          },
        },
      },
    },
    {
      name: "weather-lookup",
      displayName: "Weather Lookup",
      description:
        "Looks up current weather for a city. Use when an agent needs weather information. Returns mock data for demonstration.",
      parametersSchema: {
        type: "object",
        required: ["city"],
        properties: {
          city: { type: "string", description: "City name to look up" },
        },
      },
    },
  ],
};

export default manifest;
