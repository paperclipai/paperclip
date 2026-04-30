import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.e2b-sandbox-provider";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "E2B Sandbox Provider",
  description:
    "First-party sandbox provider plugin that provisions E2B cloud sandboxes as Paperclip execution environments.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  environmentDrivers: [
    {
      driverKey: "e2b",
      kind: "sandbox_provider",
      displayName: "E2B Cloud Sandbox",
      description:
        "Provisions E2B cloud sandboxes with configurable templates, timeouts, and lease reuse.",
      configSchema: {
        type: "object",
        properties: {
          template: {
            type: "string",
            description: "E2B sandbox template name.",
            default: "base",
          },
          apiKey: {
            type: "string",
            format: "secret-ref",
            description:
              "Environment-specific E2B API key. Paste a key or an existing Paperclip secret reference; saved environments store pasted values as company secrets. Falls back to E2B_API_KEY if omitted.",
          },
          timeoutMs: {
            type: "number",
            description: "Sandbox timeout in milliseconds.",
            default: 300000,
          },
          reuseLease: {
            type: "boolean",
            description: "Whether to pause and reuse sandboxes across runs.",
            default: false,
          },
        },
        required: ["template"],
      },
    },
  ],
};

export default manifest;
