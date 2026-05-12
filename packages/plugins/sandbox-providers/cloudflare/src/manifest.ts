import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.cloudflare-sandbox-provider";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Cloudflare Sandbox Provider",
  description:
    "First-party sandbox provider plugin that provisions Cloudflare sandboxes through an operator-deployed Worker bridge.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  environmentDrivers: [
    {
      driverKey: "cloudflare",
      kind: "sandbox_provider",
      displayName: "Cloudflare Sandbox",
      description:
        "Runs Paperclip sandbox environments through a Cloudflare Worker bridge backed by the Sandbox SDK and Durable Objects.",
      configSchema: {
        type: "object",
        properties: {
          bridgeBaseUrl: {
            type: "string",
            format: "uri",
            description: "Base URL of the operator-deployed Cloudflare Worker bridge.",
          },
          bridgeAuthToken: {
            type: "string",
            format: "secret-ref",
            description:
              "Bearer token used by the provider plugin when calling the Cloudflare bridge. Pasted values are stored as company secrets.",
          },
          reuseLease: {
            type: "boolean",
            default: false,
            description: "Reuse a sandbox by environment ID instead of creating one per run.",
          },
          keepAlive: {
            type: "boolean",
            default: false,
            description: "Prevent Cloudflare from idling the container between requests.",
          },
          sleepAfter: {
            type: "string",
            default: "10m",
            description: "Idle timeout passed to getSandbox(). Ignored when keepAlive is true.",
          },
          normalizeId: {
            type: "boolean",
            default: true,
            description: "Lowercase and normalize sandbox IDs for operator-friendly naming.",
          },
          requestedCwd: {
            type: "string",
            default: "/workspace/paperclip",
            description: "Workspace directory to create inside the sandbox lease.",
          },
          sessionStrategy: {
            type: "string",
            enum: ["named", "default"],
            default: "named",
            description: "Whether to run commands in a stable named session or the default session.",
          },
          sessionId: {
            type: "string",
            default: "paperclip",
            description: "Named Cloudflare session ID used when sessionStrategy is named.",
          },
          timeoutMs: {
            type: "number",
            default: 300000,
            description: "Default per-command timeout passed through to the bridge.",
          },
          bridgeRequestTimeoutMs: {
            type: "number",
            default: 30000,
            description: "HTTP timeout for plugin-to-bridge requests.",
          },
          previewHostname: {
            type: "string",
            description: "Optional hostname reserved for future preview URL support.",
          },
        },
        required: ["bridgeBaseUrl", "bridgeAuthToken"],
      },
    },
  ],
};

export default manifest;
