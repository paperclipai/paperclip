import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.blaxel-sandbox-provider";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Blaxel Sandbox Provider",
  description:
    "Sandbox provider plugin that provisions Blaxel microVM sandboxes as Paperclip execution environments. Leverages snapshot-based scale-to-zero for sub-25ms resume times without explicit pause/unpause.",
  author: "Blaxel",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  environmentDrivers: [
    {
      driverKey: "blaxel",
      kind: "sandbox_provider",
      displayName: "Blaxel Cloud Sandbox",
      description:
        "Provisions Blaxel microVM sandboxes with snapshot-based scale-to-zero. Sandboxes automatically hibernate when idle and resume from snapshot in ~25ms — no explicit pause/unpause needed.",
      configSchema: {
        type: "object",
        properties: {
          apiKey: {
            type: "string",
            format: "secret-ref",
            description:
              "Blaxel API key. Paste a key or an existing Paperclip secret reference; saved environments store pasted values as company secrets. Falls back to BL_API_KEY if omitted.",
          },
          workspace: {
            type: "string",
            description:
              "Blaxel workspace name. Falls back to BL_WORKSPACE if omitted.",
          },
          image: {
            type: "string",
            description: "Container image for the sandbox. Defaults to blaxel/base-image:latest when omitted.",
            default: "blaxel/base-image:latest",
          },
          memory: {
            type: "number",
            description: "Memory in MB for the sandbox.",
            default: 4096,
          },
          region: {
            type: "string",
            description: "Blaxel region (e.g. us-pdx-1, eu-lon-1, us-was-1). Falls back to BL_REGION if omitted.",
          },
          timeoutMs: {
            type: "number",
            description: "Command execution timeout in milliseconds.",
            default: 300000,
          },
          idleTtl: {
            type: "string",
            description: "How long a sandbox stays alive after last activity before being cleaned up (e.g. '30m', '2h', '24h'). Sandboxes auto-hibernate via snapshot before this; this is the final cleanup window.",
            default: "30m",
          },
        },
      },
    },
  ],
};

export default manifest;
