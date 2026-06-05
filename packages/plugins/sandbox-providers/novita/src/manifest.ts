import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.novita-sandbox-provider";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Novita Sandbox Provider",
  description:
    "Sandbox provider plugin that provisions Novita Agent Sandbox environments for Paperclip agent runs.",
  author: "Novita AI",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  environmentDrivers: [
    {
      driverKey: "novita",
      kind: "sandbox_provider",
      displayName: "Novita Agent Sandbox",
      description:
        "Provisions Novita Agent Sandbox instances with configurable templates, idle timeout, workspace path, and lease reuse.",
      configSchema: {
        type: "object",
        properties: {
          apiKey: {
            type: "string",
            format: "secret-ref",
            description:
              "Environment-specific Novita API key. Paste a key or an existing Paperclip secret reference; saved environments store pasted values as company secrets. Falls back to NOVITA_API_KEY if omitted.",
          },
          domain: {
            type: "string",
            description:
              "Optional Novita API domain override. Leave empty to use the SDK default.",
          },
          template: {
            type: "string",
            default: "base",
            description:
              "Novita sandbox template ID or name. The SDK uses the official base template when omitted.",
          },
          requestedCwd: {
            type: "string",
            default: "/home/user/paperclip-workspace",
            description: "Workspace directory to create inside the sandbox lease.",
          },
          timeoutMs: {
            type: "number",
            default: 300000,
            description:
              "Sandbox lifetime and default per-command timeout in milliseconds.",
          },
          requestTimeoutMs: {
            type: "number",
            default: 30000,
            description:
              "HTTP/RPC request timeout for Novita SDK calls in milliseconds.",
          },
          secure: {
            type: "boolean",
            default: true,
            description: "Use secure connections when supported by the Novita SDK.",
          },
          autoPause: {
            type: "boolean",
            default: false,
            description: "Enable Novita sandbox auto-pause behavior when supported by the selected template.",
          },
          reuseLease: {
            type: "boolean",
            default: false,
            description:
              "Pause and later resume the sandbox across Paperclip runs instead of killing it on release.",
          },
        },
      },
    },
  ],
};

export default manifest;
